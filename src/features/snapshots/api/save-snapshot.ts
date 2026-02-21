"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { z } from "zod";

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
        return { success: false, error: "Validation failed: " + parsed.error.message };
    }

    const { codeFournisseur, nomFournisseur, magasin, label, changes, summary } = parsed.data;

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
}
