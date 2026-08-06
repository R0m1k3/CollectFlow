import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getNetworkMetricsByCodeCentrale } from "@/lib/qlik-network-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/network/:codeCentrale
 *
 * Métriques réseau Qlik d'un produit (CA, quantité, nombre de magasins, CA/magasin,
 * marge %) et sa courbe de quantités mensuelles sur 12 mois glissants.
 *
 * Lecture **exclusive** de la table `qlik_network_metrics` : aucun appel à Qlik n'est
 * déclenché. Pour interroger Qlik en direct (y compris sur des produits que nous ne
 * référençons pas), c'est la page Produits — bien plus lente, et volontairement
 * séparé de cette API.
 */
export async function GET(
    req: NextRequest,
    ctx: { params: Promise<{ codeCentrale: string }> },
) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const { codeCentrale } = await ctx.params;
    if (!codeCentrale) return fail("bad_request", "Paramètre 'codeCentrale' requis.");

    const metrics = await getNetworkMetricsByCodeCentrale([codeCentrale]);
    const found = metrics.get(codeCentrale);
    if (!found) {
        return fail(
            "not_found",
            `Aucune donnée réseau en cache pour le code centrale « ${codeCentrale} ». Lancez une synchronisation Qlik ou une recherche réseau.`,
        );
    }

    return ok({ codeCentrale, ...found }, { meta: { fetchedAt: found.fetchedAt, source: "cache" } });
}
