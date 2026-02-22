"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { z } from "zod";
import { sql } from "drizzle-orm";

const SaveSnapshotSchema = z.object({
    codeFournisseur: z.string(),
    nomFournisseur: z.string().optional(),
    magasin: z.string(),
    label: z.string().optional(),
    changes: z.record(z.string(), z.object({
        before: z.string().nullable(),
        after: z.string(),
    })),
    summary: z.object({
        totalRows: z.number(),
        totalCa: z.number(),
        totalMarge: z.number(),
        tauxMargeGlobal: z.number(),
    }).optional(),
});

export async function saveSnapshot(raw: unknown) {
    const parsed = SaveSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
        console.error("Snapshot validation failed:", parsed.error.format());
        return { success: false, error: "Validation failed: " + parsed.error.issues.map((i: any) => i.message).join(", ") };
    }

    const { codeFournisseur, nomFournisseur, magasin, label, changes, summary } = parsed.data;

    try {
        const [created] = await db
            .insert(sessionSnapshots)
            .values({
                codeFournisseur,
                nomFournisseur: nomFournisseur ?? null,
                magasin,
                label: label ?? `Snapshot — ${new Date().toLocaleDateString("fr-FR")}`,
                changes,
                summaryJson: summary ?? null,
            })
            .returning({ id: sessionSnapshots.id });

        return { success: true, snapshotId: created?.id };
    } catch (err: any) {
        console.error("Initial snapshot save failed, attempting auto-repair...", err);

        try {
            // Tentative systématique de création de table (no-op si déjà là)
            await db.execute(sql`
                CREATE TABLE IF NOT EXISTS session_snapshots (
                    id SERIAL PRIMARY KEY,
                    code_fournisseur VARCHAR(20) NOT NULL,
                    nom_fournisseur VARCHAR(255),
                    magasin VARCHAR(20) NOT NULL,
                    changes JSONB NOT NULL,
                    summary_json JSONB,
                    label TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Deuxième tentative d'insertion
            const [retryCreated] = await db
                .insert(sessionSnapshots)
                .values({
                    codeFournisseur,
                    nomFournisseur: nomFournisseur ?? null,
                    magasin,
                    label: label ?? `Snapshot — ${new Date().toLocaleDateString("fr-FR")}`,
                    changes,
                    summaryJson: summary ?? null,
                })
                .returning({ id: sessionSnapshots.id });

            return { success: true, snapshotId: retryCreated?.id };
        } catch (repairErr: any) {
            console.error("Snapshot auto-repair/retry failed:", repairErr);
            // On renvoie les deux erreurs pour comprendre si c'est la création ou l'insertion qui échoue
            const origMsg = (err.message || String(err)).split('\n')[0];
            const retryMsg = (repairErr.message || String(repairErr)).split('\n')[0];
            return {
                success: false,
                error: `Erreur initiale: ${origMsg} | Erreur après réparation: ${retryMsg}`
            };
        }
    }
}
