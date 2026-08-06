import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { productDetailSchema } from "@/lib/api-schemas";
import { getGridRowByCodein } from "@/lib/grid-store";
import { enrichRows } from "@/lib/api-enrich";
import { getProductRows } from "@/features/grid/api/get-product-rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Idem /api/v1/grid : le calcul à la demande peut prendre plusieurs secondes.
export const maxDuration = 300;

/**
 * GET /api/v1/products/:codein?fournisseur=…
 *
 * Fiche complète d'un produit : le `ProductRow` intégral (séries mensuelles,
 * ventilations par magasin, stock, marges, gammes) enrichi des métriques réseau Qlik
 * lues **en cache** (`qlik_network_metrics`) — aucun appel à Qlik.
 *
 * `fournisseur` lève l'ambiguïté d'un article référencé chez plusieurs fournisseurs ;
 * sans lui, l'instantané le plus récent est renvoyé.
 */
export async function GET(
    req: NextRequest,
    ctx: { params: Promise<{ codein: string }> },
) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const { codein } = await ctx.params;
    if (!codein) return fail("bad_request", "Paramètre 'codein' requis.");

    const parsed = productDetailSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        return fail("bad_request", "Paramètres invalides.", parsed.error.issues);
    }

    let found = await getGridRowByCodein(codein, parsed.data.fournisseur);

    // Absent de l'instantané : on peut le calculer, mais seulement si l'appelant a
    // précisé le fournisseur — le calcul se fait par lot fournisseur, pas par article.
    if (!found && parsed.data.compute === "1" && parsed.data.fournisseur) {
        console.log(`[api/v1/products] ${codein} absent — calcul du lot ${parsed.data.fournisseur} à la demande`);
        try {
            await getProductRows({ codeFournisseur: parsed.data.fournisseur, magasin: "TOTAL" });
            found = await getGridRowByCodein(codein, parsed.data.fournisseur);
        } catch (e) {
            console.error(`[api/v1/products] calcul KO pour ${parsed.data.fournisseur}:`, e instanceof Error ? e.message : String(e));
        }
    }

    if (!found) {
        return fail(
            "not_found",
            parsed.data.fournisseur
                ? `Produit « ${codein} » introuvable chez le fournisseur « ${parsed.data.fournisseur} ».`
                : `Aucun instantané pour le produit « ${codein} ». Ajoutez « fournisseur=… » pour que l'API calcule le lot à la demande.`,
        );
    }

    // Métriques réseau + gamme serveur relues maintenant : le payload date du dernier
    // calcul de la grille, alors que ces deux données évoluent indépendamment.
    const [enriched] = await enrichRows([found.row]);

    return ok(enriched, {
        meta: {
            computedAt: found.computedAt,
            networkFetchedAt: enriched.network?.fetchedAt ?? null,
            hasNetwork: enriched.network !== null,
        },
    });
}
