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
        console.error("Snapshot DB error, attempting auto-repair:", err);

        // Si la table n'existe pas, on tente de la créer
        if (err.message?.includes("relation") && err.message?.includes("does not exist")) {
            try {
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
                // On ré-essaie l'insertion une seule fois
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
            } catch (repairErr: any) {
                console.error("Auto-repair failed:", repairErr);
                return { success: false, error: `Repair failed: ${repairErr.message}` };
            }
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, error: `DB Error: ${errorMessage}` };
    }
}
