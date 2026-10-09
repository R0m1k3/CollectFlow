import "server-only";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { patchGridRowsCache } from "./get-product-rows";
import { updateGridRowsGamme } from "@/lib/grid-store";

export interface ChangementGamme {
    codein: string;
    /** Gamme avant la modification (état serveur), conservée pour l'historique. */
    codeGammeBefore: string | null;
    codeGamme: string;
}

/** Gammes d'un snapshot : codein → gamme avant (état FF) / après. */
export type GammesSnapshot = Record<string, { before: string | null; after: string }>;

/**
 * Dernier snapshot du fournisseur — celui que la Grille réapplique à chaque calcul
 * (Phase 9). `null` s'il n'y en a aucun ; lève une erreur si la lecture échoue.
 */
export async function lireDernierSnapshot(
    codeFournisseur: string,
): Promise<{ id: number; changes: GammesSnapshot } | null> {
    const [dernier] = await db
        .select({ id: sessionSnapshots.id, changes: sessionSnapshots.changes })
        .from(sessionSnapshots)
        .where(eq(sessionSnapshots.codeFournisseur, codeFournisseur))
        .orderBy(desc(sessionSnapshots.createdAt))
        .limit(1);
    return dernier ? { id: dernier.id, changes: (dernier.changes ?? {}) as GammesSnapshot } : null;
}

export interface EnregistrementGammes {
    codeFournisseur: string;
    nomFournisseur?: string | null;
    magasin: string;
    changes: ChangementGamme[];
    userId: number | null;
    /** Libellé du snapshot, « Draft — date » par défaut. */
    label?: string;
}

/**
 * Enregistre des gammes pour un fournisseur — chemin unique de la Grille et de /api/v1.
 *
 * Les changements sont fusionnés par-dessus le dernier snapshot du fournisseur,
 * puis reportés dans le cache mémoire de la Grille et dans l'instantané `grid_rows`.
 * Lève une erreur si l'écriture du snapshot échoue.
 */
export async function enregistrerGammes(input: EnregistrementGammes): Promise<number> {
    const { codeFournisseur, nomFournisseur, magasin, changes, userId } = input;
    if (changes.length === 0) return 0;

    // Charger le dernier snapshot existant pour merger les changements
    const prevChanges = (await lireDernierSnapshot(codeFournisseur))?.changes ?? {};

    // Merger les nouveaux changements par-dessus l'existant
    const mergedChanges = { ...prevChanges };
    for (const c of changes) {
        mergedChanges[c.codein] = {
            before: c.codeGammeBefore,
            after: c.codeGamme,
        };
    }

    // Upsert : insérer un nouveau snapshot "draft" pour ce fournisseur
    await db.insert(sessionSnapshots).values({
        userId,
        codeFournisseur,
        nomFournisseur: nomFournisseur ?? null,
        magasin,
        label: input.label ?? `Draft — ${new Date().toLocaleDateString("fr-FR")}`,
        changes: mergedChanges,
        summaryJson: null,
        type: "snapshot",
    });

    // Les lignes en cache reçoivent les nouvelles gammes au lieu d'être jetées :
    // l'invalidation imposait un recalcul complet (jusqu'à ~40 s) à la
    // réouverture suivante. L'instantané lu par /api/v1 suit, sans bloquer.
    patchGridRowsCache(codeFournisseur, changes);
    void updateGridRowsGamme(codeFournisseur, changes).catch((e) =>
        console.error("[enregistrerGammes] mise à jour grid_rows KO:", (e as Error).message?.slice(0, 200)),
    );

    return changes.length;
}
