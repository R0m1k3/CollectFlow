"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

const SaveDraftsSchema = z.object({
    changes: z.array(
        z.object({
            codein: z.string(),
            magasin: z.string(),
            codeGamme: z.enum(["A", "B", "C", "Z"]),
        })
    ),
});

export async function saveDraftChanges(
    raw: unknown
): Promise<{ success: boolean; saved: number; error?: string }> {
    const parsed = SaveDraftsSchema.safeParse(raw);
    if (!parsed.success) {
        return { success: false, saved: 0, error: "Validation failed: " + parsed.error.message };
    }

    const { changes } = parsed.data;

    try {
        // Batch update all rows for given codein × magasin
        await Promise.all(
            changes.map(({ codein, magasin, codeGamme }) =>
                db
                    .update(ventesProduits)
                    .set({ codeGamme })
                    .where(
                        and(
                            eq(ventesProduits.codein, codein),
                            eq(ventesProduits.magasin, magasin)
                        )
                    )
            )
        );

        return { success: true, saved: changes.length };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, saved: 0, error: msg };
    }
}
