"use server";

import { z } from "zod";
import { verifierSession } from "@/lib/authz";
import { lireDernierSnapshot } from "./enregistrer-gammes";

/**
 * Gammes enregistrées pour un fournisseur (dernier snapshot), quelle qu'en soit
 * l'origine : la Grille, ou l'API /api/v1 pendant que la Grille était ouverte.
 *
 * `snapshotId` identifie l'état lu : `saveSnapshot` s'en sert pour reprendre les
 * gammes enregistrées APRÈS cette lecture au lieu de les écraser.
 */
export async function lireGammesEnregistrees(
    raw: unknown,
): Promise<
    | { success: true; snapshotId: number | null; gammes: Record<string, string> }
    | { success: false; error: string }
> {
    const acces = await verifierSession();
    if (!acces.ok) return { success: false, error: acces.message };

    const parsed = z.string().min(1).safeParse(raw);
    if (!parsed.success) return { success: false, error: "Code fournisseur manquant." };

    try {
        const dernier = await lireDernierSnapshot(parsed.data);
        const gammes: Record<string, string> = {};
        for (const [codein, delta] of Object.entries(dernier?.changes ?? {})) {
            if (delta?.after) gammes[codein] = delta.after;
        }
        return { success: true, snapshotId: dernier?.id ?? null, gammes };
    } catch (err) {
        console.error("[lireGammesEnregistrees]", err instanceof Error ? err.message : String(err));
        return { success: false, error: "lecture des gammes enregistrées impossible" };
    }
}
