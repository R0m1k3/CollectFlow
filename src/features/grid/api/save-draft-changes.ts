"use server";

import { z } from "zod";
import { verifierSession } from "@/lib/authz";
import { enregistrerGammes } from "./enregistrer-gammes";

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
    const acces = await verifierSession();
    if (!acces.ok) return { success: false, saved: 0, error: acces.message };

    const parsed = SaveDraftsSchema.safeParse(raw);
    if (!parsed.success) {
        return { success: false, saved: 0, error: "Validation failed: " + parsed.error.message };
    }

    const { codeFournisseur, nomFournisseur, magasin, changes } = parsed.data;

    const rawUserId = acces.utilisateur.id;
    const userId = rawUserId ? parseInt(rawUserId, 10) : null;
    const finalUserId = userId && !isNaN(userId) ? userId : null;

    try {
        const saved = await enregistrerGammes({ codeFournisseur, nomFournisseur, magasin, changes, userId: finalUserId });
        return { success: true, saved };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { success: false, saved: 0, error: msg };
    }
}
