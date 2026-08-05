import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { productDetailSchema } from "@/lib/api-schemas";
import { getGridRowByCodein } from "@/lib/grid-store";
import { getNetworkMetricsByCodeCentrale } from "@/lib/qlik-network-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const found = await getGridRowByCodein(codein, parsed.data.fournisseur);
    if (!found) {
        return fail(
            "not_found",
            `Aucun instantané pour le produit « ${codein} ». Le fournisseur a-t-il déjà été ouvert dans la Grille ?`,
        );
    }

    // Métriques réseau à jour depuis le cache (le payload peut dater du dernier calcul).
    let network = null;
    if (found.row.codeCentrale) {
        const metrics = await getNetworkMetricsByCodeCentrale([found.row.codeCentrale]);
        network = metrics.get(found.row.codeCentrale) ?? null;
    }

    return ok(
        { ...found.row, network },
        { meta: { computedAt: found.computedAt, networkFetchedAt: network?.fetchedAt ?? null } },
    );
}
