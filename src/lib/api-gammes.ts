/**
 * CollectFlow — Affectation de gammes via l'API `/api/v1`.
 *
 * L'API suit exactement le chemin de la Grille (`enregistrerGammes`) : la gamme est
 * enregistrée dans le snapshot du fournisseur, reportée dans l'instantané
 * `grid_rows` et visible immédiatement dans l'application. Comme dans la Grille,
 * rien n'est écrit dans la base FF : `codeGammeServeur` reste la gamme d'origine
 * jusqu'à l'import des gammes modifiées.
 *
 * Tout ou rien : si un seul article est inconnu chez le fournisseur, rien n'est
 * enregistré et la réponse liste les articles en cause.
 */

import "server-only";

import type { NextRequest } from "next/server";
import { fail } from "@/lib/api-response";
import { getGridFreshness, getGridRowsGammes } from "@/lib/grid-store";
import { getProductRows } from "@/features/grid/api/get-product-rows";
import { enregistrerGammes, type ChangementGamme } from "@/features/grid/api/enregistrer-gammes";

export interface ResultatGamme {
    codein: string;
    /** Gamme désormais affectée. */
    gamme: string;
    /** Gamme courante avant l'appel (modifications enregistrées comprises). */
    gammePrecedente: string | null;
    /** Gamme présente en base FF, non modifiée par l'API. */
    codeGammeServeur: string | null;
    /** `false` quand l'article avait déjà cette gamme : rien n'a été écrit pour lui. */
    modifie: boolean;
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
 * Affecte des gammes à des articles d'un fournisseur.
 *
 * Si le fournisseur n'a encore jamais été calculé, son instantané est calculé à la
 * demande (`compute`), comme sur `/grid` : sans lui, impossible de vérifier que les
 * articles lui appartiennent.
 */
export async function affecterGammes(input: {
    codeFournisseur: string;
    changes: ReadonlyArray<{ codein: string; gamme: string }>;
    compute: boolean;
    /** Nom de la clé d'API ou de l'utilisateur — repris dans le libellé du snapshot. */
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
    const changements: ChangementGamme[] = [];
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
        });
        if (modifie) {
            // Même « avant » que la Grille : l'état serveur, à défaut la gamme courante.
            changements.push({ codein, codeGammeBefore: actuelle.codeGammeInit ?? actuelle.codeGamme, codeGamme: gamme });
        }
    }

    try {
        await enregistrerGammes({
            codeFournisseur,
            nomFournisseur,
            magasin: "TOTAL",
            changes: changements,
            userId: null,
            label: `API (${auteur}) — ${new Date().toLocaleDateString("fr-FR")}`,
        });
    } catch (e) {
        console.error(`[api/v1/gammes] enregistrement KO pour ${codeFournisseur}:`, e instanceof Error ? e.message : String(e));
        return fail("internal_error", "L'enregistrement des gammes a échoué.");
    }

    console.log(`[api/v1/gammes] ${codeFournisseur} — ${changements.length} gamme(s) enregistrée(s) par ${auteur}`);
    return { codeFournisseur, nomFournisseur, resultats };
}
