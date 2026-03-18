"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";

const SaveDraftsSchema = z.object({
    codeFournisseur: z.string(),
    nomFournisseur: z.string().optional(),
    magasin: z.string(),
    changes: z.array(
        z.object({
            codein: z.string(),
            codeGammeBefore: z.string().nullable(),
            codeGamme: z.string(),
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

    const { codeFournisseur, nomFournisseur, magasin, changes } = parsed.data;

    const session = await auth();
    const rawUserId = (session?.user as { id?: string | number })?.id;
    const userId = rawUserId ? parseInt(String(rawUserId), 10) : null;
    const finalUserId = userId && !isNaN(userId) ? userId : null;

    try {
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
            userId: finalUserId,
            codeFournisseur,
            nomFournisseur: nomFournisseur ?? null,
            magasin,
            label: `Draft — ${new Date().toLocaleDateString("fr-FR")}`,
            changes: mergedChanges,
            summaryJson: null,
            type: "snapshot",
        });

        return { success: true, saved: changes.length };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, saved: 0, error: msg };
    }
}
