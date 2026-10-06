import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { productGammeBodySchema } from "@/lib/api-schemas";
import { listGridSuppliersForCodein } from "@/lib/grid-store";
import { affecterGammes, lireCorpsJson } from "@/lib/api-gammes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Idem /api/v1/grid : le calcul à la demande peut prendre plusieurs secondes.
export const maxDuration = 300;

/**
 * PUT /api/v1/products/:codein/gamme   { "gamme": "A", "fournisseur"?: "…" }
 *
 * Propose une gamme pour un article. La proposition reste **à valider** : elle
 * apparaît dans la Grille comme une modification non enregistrée, et `codeGamme`
 * ne change qu'une fois validée (« Enregistrer » dans la Grille).
 *
 * `fournisseur` n'est requis que si l'article est référencé chez plusieurs
 * fournisseurs, ou s'il n'apparaît pas encore dans l'instantané.
 */
export async function PUT(
    req: NextRequest,
    ctx: { params: Promise<{ codein: string }> },
) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const { codein } = await ctx.params;
    if (!codein) return fail("bad_request", "Paramètre 'codein' requis.");

    const corps = await lireCorpsJson(req);
    if (corps instanceof Response) return corps;
    const parsed = productGammeBodySchema.safeParse(corps);
    if (!parsed.success) {
        return fail("bad_request", "Corps de requête invalide.", parsed.error.issues);
    }
    const { gamme, compute } = parsed.data;

    let fournisseur = parsed.data.fournisseur;
    if (!fournisseur) {
        const fournisseurs = await listGridSuppliersForCodein(codein);
        if (fournisseurs.length === 0) {
            return fail(
                "not_found",
                `Aucun instantané pour le produit « ${codein} ». Ajoutez « fournisseur » au corps de la requête pour que l'API calcule le lot à la demande.`,
            );
        }
        if (fournisseurs.length > 1) {
            return fail(
                "bad_request",
                `Le produit « ${codein} » est référencé chez plusieurs fournisseurs : précisez « fournisseur ».`,
                { fournisseurs },
            );
        }
        fournisseur = fournisseurs[0].codeFournisseur;
    }

    const res = await affecterGammes({
        codeFournisseur: fournisseur,
        changes: [{ codein, gamme }],
        compute,
        auteur: authCtx.subject,
    });
    if (res instanceof Response) return res;

    return ok(
        { ...res.resultats[0], codeFournisseur: res.codeFournisseur, nomFournisseur: res.nomFournisseur },
        { meta: { enregistreLe: new Date().toISOString() } },
    );
}
