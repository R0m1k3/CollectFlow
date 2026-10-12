/**
 * Gammes proposées par l'API `/api/v1`, en attente de validation dans la
 * Grille — actions exécutées par le serveur Rust : `POST /api/actions/{nom}`.
 */

import { callAction } from "@/lib/rpc";
import type { GammeAValider } from "@/types/ff";

export type { GammeAValider };

/** Gammes proposées par l'API pour un fournisseur, en attente de validation. */
export async function getGammesAValider(
    codeFournisseur: string,
): Promise<{ success: boolean; propositions: GammeAValider[]; error?: string }> {
    return callAction("getGammesAValider", [codeFournisseur]);
}

/** Rejette des propositions de l'API (« Annuler les modifications » dans la Grille). */
export async function rejeterGammesAValider(raw: unknown): Promise<{ success: boolean; error?: string }> {
    return callAction("rejeterGammesAValider", [raw]);
}
