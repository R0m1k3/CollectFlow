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
    const existing = await db
        .select()
        .from(sessionSnapshots)
        .where(eq(sessionSnapshots.codeFournisseur, codeFournisseur))
        .orderBy(desc(sessionSnapshots.createdAt))
        .limit(1);

    const prevChanges: Record<string, { before: string | null; after: string }> =
        existing.length > 0
            ? (existing[0].changes as Record<string, { before: string | null; after: string }>)
            : {};

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
