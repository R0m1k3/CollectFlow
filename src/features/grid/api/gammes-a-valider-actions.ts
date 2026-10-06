"use server";

import { z } from "zod";
import { verifierSession } from "@/lib/authz";
import { listerGammesAValider, supprimerGammesAValider, type GammeAValider } from "@/lib/gammes-a-valider";

/** Gammes proposées par l'API pour un fournisseur, en attente de validation. */
export async function getGammesAValider(
    codeFournisseur: string,
): Promise<{ success: boolean; propositions: GammeAValider[]; error?: string }> {
    const acces = await verifierSession();
    if (!acces.ok) return { success: false, propositions: [], error: acces.message };
    try {
        return { success: true, propositions: await listerGammesAValider(String(codeFournisseur)) };
    } catch (err) {
        return { success: false, propositions: [], error: err instanceof Error ? err.message : "Unknown error" };
    }
}

const RejetSchema = z.object({
    codeFournisseur: z.string().min(1),
    codeins: z.array(z.string()),
});

/** Rejette des propositions de l'API (« Annuler les modifications » dans la Grille). */
export async function rejeterGammesAValider(raw: unknown): Promise<{ success: boolean; error?: string }> {
    const acces = await verifierSession();
    if (!acces.ok) return { success: false, error: acces.message };
    const parsed = RejetSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: "Validation failed: " + parsed.error.message };
    try {
        await supprimerGammesAValider(parsed.data.codeFournisseur, parsed.data.codeins);
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
}
