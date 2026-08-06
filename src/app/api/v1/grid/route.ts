import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail, buildPagination } from "@/lib/api-response";
import { gridQuerySchema, pickFields, toSortKey } from "@/lib/api-schemas";
import { queryGridRows, getGridFreshness } from "@/lib/grid-store";
import { enrichRows } from "@/lib/api-enrich";
import { getProductRows } from "@/features/grid/api/get-product-rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Le calcul à la demande (premier appel sur un fournisseur inconnu) enchaîne
// plusieurs requêtes SQL sur la base miroir FF : on laisse de la marge.
export const maxDuration = 300;

/**
 * GET /api/v1/grid?fournisseur=…&gamme=&code1..3=&search=&sort=&order=&page=&limit=&fields=&compute=
 *
 * Lignes de grille d'un fournisseur, filtrées / triées / paginées **en SQL** depuis
 * l'instantané persisté (`grid_rows`).
 *
 * Si le fournisseur n'a pas encore d'instantané, l'endpoint le **calcule à la demande**
 * (`compute=1`, défaut) : sans cela, un appelant externe ne pourrait consulter que les
 * fournisseurs déjà ouverts dans la Grille par un humain. Le calcul est protégé par le
 * cache et le verrou anti-concurrence de `getProductRows()`, et il persiste l'instantané
 * au passage — les appels suivants repassent donc par le chemin rapide.
 *
 * `compute=0` restaure le comportement strict : échec immédiat en `202 not_ready`.
 */
export async function GET(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const parsed = gridQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        return fail("bad_request", "Paramètres invalides.", parsed.error.issues);
    }
    const q = parsed.data;

    // Distingue « fournisseur jamais calculé » de « filtres sans résultat » (200 vide).
    let freshness = await getGridFreshness(q.fournisseur);
    let computedOnDemand = false;

    if (!freshness) {
        if (q.compute === "0") {
            return fail(
                "not_ready",
                `Aucun instantané pour le fournisseur « ${q.fournisseur} ». Relancez sans « compute=0 » pour le calculer à la demande.`,
                { fournisseur: q.fournisseur },
            );
        }

        console.log(`[api/v1/grid] instantané absent pour ${q.fournisseur} — calcul à la demande (via ${authCtx.via})`);
        try {
            // magasin TOTAL : c'est la seule variante persistée par getProductRows,
            // et ProductRow embarque déjà les ventilations par magasin.
            await getProductRows({ codeFournisseur: q.fournisseur, magasin: "TOTAL" });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[api/v1/grid] calcul à la demande KO pour ${q.fournisseur}:`, msg);
            return fail(
                "internal_error",
                `Le calcul de la grille a échoué pour le fournisseur « ${q.fournisseur} ».`,
                { fournisseur: q.fournisseur },
            );
        }

        freshness = await getGridFreshness(q.fournisseur);
        if (!freshness) {
            // Calcul réussi mais aucune ligne : le code fournisseur n'existe pas, ou
            // il n'a aucun article. À distinguer d'une panne.
            return fail(
                "not_found",
                `Aucun article pour le fournisseur « ${q.fournisseur} ». Vérifiez le code auprès de /api/v1/fournisseurs.`,
                { fournisseur: q.fournisseur },
            );
        }
        computedOnDemand = true;
    }

    const result = await queryGridRows({
        codeFournisseur: q.fournisseur,
        gamme: q.gamme,
        code1: q.code1,
        code2: q.code2,
        code3: q.code3,
        search: q.search,
        sort: toSortKey(q.sort),
        order: q.order,
        page: q.page,
        limit: q.limit,
    });

    // Métriques Qlik et gamme serveur relues au moment de l'appel (voir api-enrich).
    const rows = q.enrich === "1" ? await enrichRows(result.rows) : result.rows;

    const pagination = buildPagination(q.page, q.limit, result.total);

    return ok(
        rows.map((r) => pickFields(r, q.fields)),
        {
            pagination,
            meta: {
                fournisseur: q.fournisseur,
                computedAt: result.computedAt,
                snapshotComputedAt: freshness.computedAt,
                snapshotRowCount: freshness.rowCount,
                enrichi: q.enrich === "1",
                /** true = l'instantané n'existait pas et vient d'être calculé par cet appel. */
                computedOnDemand,
                /**
                 * true = cette réponse contient **toutes** les lignes du fournisseur.
                 * Dit explicitement à un appelant — en particulier un agent — s'il
                 * peut s'arrêter là, au lieu de le laisser déduire d'une pagination
                 * qu'il risque d'ignorer.
                 */
                complet: !pagination.hasMore,
                ...(pagination.hasMore
                    ? {
                        avertissement:
                            `Réponse partielle : ${rows.length} lignes sur ${result.total}. `
                            + `Relancez avec page=${q.page + 1}, ou augmentez limit (5000 au maximum) pour tout obtenir en un appel.`,
                    }
                    : {}),
            },
        },
    );
}
