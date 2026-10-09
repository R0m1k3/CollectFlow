"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { z } from "zod";
import { sql, and, eq } from "drizzle-orm";
import { verifierSession } from "@/lib/authz";
import { revalidatePath } from "next/cache";
import { lireDernierSnapshot, type GammesSnapshot } from "@/features/grid/api/enregistrer-gammes";

const SaveSnapshotSchema = z.object({
    codeFournisseur: z.string(),
    nomFournisseur: z.string().optional(),
    magasin: z.string(),
    label: z.string().optional(),
    changes: z.record(z.string(), z.object({
        before: z.string().nullable(),
        after: z.string(),
    })),
    type: z.enum(["snapshot", "export"]).optional(),
    /**
     * Snapshot sur lequel l'écran s'est aligné juste avant (cf. lireGammesEnregistrees),
     * `null` s'il n'y en avait aucun. Absent : tout le dernier snapshot est repris.
     */
    baseSnapshotId: z.number().int().nullable().optional(),
    summary: z.object({
        totalRows: z.number(),
        totalCa: z.number(),
        totalMarge: z.number(),
        tauxMargeGlobal: z.number(),
    }).optional(),
});

export async function saveSnapshot(raw: unknown) {
    const acces = await verifierSession();
    if (!acces.ok) return { success: false, error: acces.message };

    const parsed = SaveSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
        console.error("Snapshot validation failed:", parsed.error.format());
        return { success: false, error: "Validation failed: " + parsed.error.issues.map((i: any) => i.message).join(", ") };
    }

    const { codeFournisseur, nomFournisseur, magasin, label, summary, type, baseSnapshotId } = parsed.data;
    const rawUserId = acces.utilisateur.id;
    const userId = rawUserId ? parseInt(rawUserId, 10) : null;

    console.log(`[saveSnapshot] User: ${userId} (raw: ${rawUserId}), Supplier: ${codeFournisseur}, Type: ${type}`);

    const finalUserId = (userId && !isNaN(userId)) ? userId : null;

    // Ce snapshot devient le dernier, celui que la Grille réapplique : il ne doit
    // pas effacer les gammes enregistrées depuis que l'écran s'est aligné (API).
    let changes = parsed.data.changes;
    try {
        changes = await reprendreGammesRecentes(codeFournisseur, changes, baseSnapshotId);
    } catch (err) {
        // Table absente ou base indisponible : l'insertion ci-dessous le dira.
        console.error("[saveSnapshot] lecture du dernier snapshot KO:", err);
    }

    try {
        const [created] = await db
            .insert(sessionSnapshots)
            .values({
                userId: finalUserId,
                codeFournisseur,
                nomFournisseur: nomFournisseur ?? null,
                magasin,
                label: label ?? `${type === 'export' ? 'Export' : 'Snapshot'} — ${new Date().toLocaleDateString("fr-FR")}`,
                changes,
                summaryJson: summary ?? null,
                type: type ?? "snapshot",
            })
            .returning({ id: sessionSnapshots.id });
        
        revalidatePath("/snapshots");
        revalidatePath("/exports");
        return { success: true, snapshotId: created?.id };
    } catch (err) {
        console.error("Initial snapshot save failed, attempting auto-repair...", err);

        try {
            // Tentative systématique de création de table (no-op si déjà là)
            await db.execute(sql`
                CREATE TABLE IF NOT EXISTS session_snapshots (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER,
                    code_fournisseur VARCHAR(20) NOT NULL,
                    nom_fournisseur VARCHAR(255),
                    magasin VARCHAR(20) NOT NULL,
                    changes JSONB NOT NULL,
                    summary_json JSONB,
                    label TEXT,
                    type VARCHAR(20) DEFAULT 'snapshot',
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Si la table existait déjà mais sans la colonne 'type' ou 'user_id', on les ajoute
            try {
                await db.execute(sql`ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'snapshot'`);
                await db.execute(sql`ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS user_id INTEGER`);
            } catch (e) {
                // Ignore
            }

            // Deuxième tentative d'insertion
            const [retryCreated] = await db
                .insert(sessionSnapshots)
                .values({
                    userId: finalUserId,
                    codeFournisseur,
                    nomFournisseur: nomFournisseur ?? null,
                    magasin,
                    label: label ?? `${type === 'export' ? 'Export' : 'Snapshot'} — ${new Date().toLocaleDateString("fr-FR")}`,
                    changes,
                    summaryJson: summary ?? null,
                    type: type ?? "snapshot",
                })
                .returning({ id: sessionSnapshots.id });

            return { success: true, snapshotId: retryCreated?.id };
        } catch (repairErr) {
            // Le détail technique (les deux erreurs) reste dans les journaux du serveur.
            console.error("Snapshot auto-repair/retry failed:", repairErr);
            return { success: false, error: "erreur technique sur le serveur" };
        }
    }
}

/**
 * Ajoute aux gammes de l'écran celles enregistrées depuis le snapshot `baseSnapshotId`
 * (sur lequel l'écran s'est aligné) : ce sont des écritures que l'écran n'a pas vues,
 * typiquement par l'API. Les autres gammes du dernier snapshot, l'écran les
 * connaissait : son état (retours à la gamme FF compris) fait foi.
 */
async function reprendreGammesRecentes(
    codeFournisseur: string,
    changes: GammesSnapshot,
    baseSnapshotId: number | null | undefined,
): Promise<GammesSnapshot> {
    const dernier = await lireDernierSnapshot(codeFournisseur);
    if (!dernier || dernier.id === baseSnapshotId) return changes;

    let base: GammesSnapshot = {};
    if (baseSnapshotId != null) {
        const [ligne] = await db
            .select({ changes: sessionSnapshots.changes })
            .from(sessionSnapshots)
            .where(and(eq(sessionSnapshots.id, baseSnapshotId), eq(sessionSnapshots.codeFournisseur, codeFournisseur)))
            .limit(1);
        base = (ligne?.changes ?? {}) as GammesSnapshot;
    }

    const fusion = { ...changes };
    for (const [codein, delta] of Object.entries(dernier.changes)) {
        if (delta?.after && delta.after !== base[codein]?.after) fusion[codein] = delta;
    }
    return fusion;
}
