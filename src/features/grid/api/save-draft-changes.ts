/**
 * Enregistrement des gammes modifiées dans la Grille — action exécutée par le
 * serveur Rust : `POST /api/actions/saveDraftChanges` (validation comprise).
 */

import { callAction } from "@/lib/rpc";

/** Données attendues par le serveur (ex-schéma zod `SaveDraftsSchema`). */
export interface SaveDraftsInput {
    codeFournisseur: string;
    nomFournisseur?: string;
    magasin: string;
    changes: { codein: string; codeGammeBefore: string | null; codeGamme: string }[];
    /**
     * Propositions de l'API examinées dans la Grille : validées (présentes dans
     * `changes`) ou écartées. Elles quittent la file « à valider ».
     */
    gammesAValiderTraitees?: string[];
}

export async function saveDraftChanges(
    raw: unknown
): Promise<{ success: boolean; saved: number; error?: string }> {
    return callAction("saveDraftChanges", [raw]);
}
