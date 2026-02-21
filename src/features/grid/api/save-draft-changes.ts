"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import { revalidatePath } from "next/cache";

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
        // Batch update all rows for given codein. 
        // If magasin is "TOTAL", update ALL stores for that product.
        await Promise.all(
            changes.map(({ codein, magasin, codeGamme }) => {
                const whereClause = [eq(ventesProduits.codein, codein)];
                if (magasin !== "TOTAL") {
                    whereClause.push(eq(ventesProduits.magasin, magasin));
                }

                return db
                    .update(ventesProduits)
                    .set({ codeGamme })
                    .where(and(...whereClause));
            })
        );

        revalidatePath("/grid");
        return { success: true, saved: changes.length };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, saved: 0, error: msg };
    }
}
