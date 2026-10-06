/**
 * CollectFlow — Affectation de gammes via l'API `/api/v1`.
 *
 * L'API n'enregistre pas la gamme : elle la **propose**. La proposition est
 * rangée dans `gammes_a_valider` et apparaît dans la Grille comme une
 * modification non enregistrée — on y voit donc quels produits changent de gamme
 * avant de valider (« Enregistrer », même chemin que toute modification de la
 * Grille) ou de rejeter (« Annuler les modifications »). Tant qu'elle n'est pas
 * validée, `codeGamme` reste inchangée et la proposition est exposée dans
 * `gammeAValider`.
 *
 * Tout ou rien : si un seul article est inconnu chez le fournisseur, rien n'est
 * proposé et la réponse liste les articles en cause.
 */

import "server-only";

import type { NextRequest } from "next/server";
import { fail } from "@/lib/api-response";
import { getGridFreshness, getGridRowsGammes } from "@/lib/grid-store";
import { getProductRows } from "@/features/grid/api/get-product-rows";
import { proposerGammes, type PropositionGamme } from "@/lib/gammes-a-valider";

export interface ResultatGamme {
    codein: string;
    /** Gamme proposée. */
    gamme: string;
    /** Gamme enregistrée au moment de l'appel (modifications validées comprises). */
    gammePrecedente: string | null;
    /** Gamme présente en base FF, non modifiée par l'API. */
    codeGammeServeur: string | null;
    /**
     * `true` = la gamme change : proposition déposée, à valider dans la Grille.
     * `false` = l'article a déjà cette gamme : rien à valider (une proposition
     * antérieure en attente pour lui est retirée).
     */
    modifie: boolean;
    /** `a_valider` quand `modifie`, sinon `inchangee`. */
    statut: "a_valider" | "inchangee";
}

export interface AffectationGammes {
    codeFournisseur: string;
    nomFournisseur: string | null;
    resultats: ResultatGamme[];
}

/** Lit un corps JSON, ou renvoie une réponse 400 prête à être retournée. */
export async function lireCorpsJson(req: NextRequest): Promise<unknown | Response> {
    try {
        return await req.json();
    } catch {
        return fail("bad_request", "Corps de requête JSON attendu (Content-Type: application/json).");
    }
}

/**
 * Propose des gammes pour des articles d'un fournisseur (à valider dans la Grille).
 *
 * Si le fournisseur n'a encore jamais été calculé, son instantané est calculé à la
 * demande (`compute`), comme sur `/grid` : sans lui, impossible de vérifier que les
 * articles lui appartiennent.
 */
export async function affecterGammes(input: {
    codeFournisseur: string;
    changes: ReadonlyArray<{ codein: string; gamme: string }>;
    compute: boolean;
    /** Nom de la clé d'API ou de l'utilisateur — affiché dans la Grille avec la proposition. */
    auteur: string;
}): Promise<AffectationGammes | Response> {
    const { codeFournisseur, compute, auteur } = input;

    // Un même article cité deux fois : la dernière valeur l'emporte.
    const demandes = new Map(input.changes.map((c) => [c.codein, c.gamme]));
    const codeins = [...demandes.keys()];

    if (compute && !(await getGridFreshness(codeFournisseur))) {
        console.log(`[api/v1/gammes] instantané absent pour ${codeFournisseur} — calcul à la demande`);
        try {
            await getProductRows({ codeFournisseur, magasin: "TOTAL" });
        } catch (e) {
            console.error(`[api/v1/gammes] calcul KO pour ${codeFournisseur}:`, e instanceof Error ? e.message : String(e));
            return fail("internal_error", `Le calcul de la grille a échoué pour le fournisseur « ${codeFournisseur} ».`);
        }
    }

    const actuelles = await getGridRowsGammes(codeFournisseur, codeins);
    const inconnus = codeins.filter((c) => !actuelles.has(c));
    if (inconnus.length > 0) {
        return fail(
            "not_found",
            `${inconnus.length} article(s) introuvable(s) chez le fournisseur « ${codeFournisseur} » : aucune gamme n'a été enregistrée.`,
            { fournisseur: codeFournisseur, inconnus },
        );
    }

    const resultats: ResultatGamme[] = [];
    const propositions: PropositionGamme[] = [];
    const annules: string[] = [];
    let nomFournisseur: string | null = null;

    for (const [codein, gamme] of demandes) {
        const actuelle = actuelles.get(codein)!;
        nomFournisseur ??= actuelle.nomFournisseur;
        const modifie = actuelle.codeGamme !== gamme;
        resultats.push({
            codein,
            gamme,
            gammePrecedente: actuelle.codeGamme,
            codeGammeServeur: actuelle.codeGammeInit,
            modifie,
            statut: modifie ? "a_valider" : "inchangee",
        });
        if (modifie) propositions.push({ codein, gamme, gammePrecedente: actuelle.codeGamme });
        else annules.push(codein);
    }

    try {
        await proposerGammes({ codeFournisseur, propositions, annules, auteur });
    } catch (e) {
        console.error(`[api/v1/gammes] proposition KO pour ${codeFournisseur}:`, e instanceof Error ? e.message : String(e));
        return fail("internal_error", "L'enregistrement des gammes à valider a échoué.");
    }

    console.log(`[api/v1/gammes] ${codeFournisseur} — ${propositions.length} gamme(s) à valider proposée(s) par ${auteur}`);
    return { codeFournisseur, nomFournisseur, resultats };
}
