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

    const filtres = {
        codeFournisseur: q.fournisseur,
        gamme: q.gamme,
        code1: q.code1,
        code2: q.code2,
        code3: q.code3,
        search: q.search,
        sort: toSortKey(q.sort),
        order: q.order,
    };

    // Sans `limit`, la réponse peut porter tout un fournisseur — et certains en
    // comptent plus de 130 000. Tout charger puis tout sérialiser d'un bloc ferait
    // exploser la mémoire du processus : on diffuse par lots, à mémoire constante.
    if (q.limit == null) {
        return streamAllRows(req, filtres, q, freshness, computedOnDemand);
    }

    const result = await queryGridRows({ ...filtres, page: q.page, limit: q.limit });

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
                            `Réponse partielle : ${rows.length} lignes sur ${result.total}, parce que « limit » a été précisé. `
                            + `Retirez « limit » pour obtenir tout le fournisseur en un appel, ou passez à page=${q.page + 1}.`,
                    }
                    : {}),
            },
        },
    );
}

/** Lots internes : compromis entre nombre d'allers-retours SQL et mémoire retenue. */
const STREAM_BATCH = 1000;

type Filtres = Parameters<typeof queryGridRows>[0];

/**
 * Diffuse **toutes** les lignes du fournisseur en une seule réponse JSON, sans
 * jamais la construire entièrement en mémoire.
 *
 * La forme reste celle des autres réponses (`{ data, pagination, meta }`) : un
 * client existant ne voit aucune différence, il reçoit simplement les octets au
 * fil de l'eau. `pagination` et `meta` sont écrits en dernier, une fois le total
 * connu — l'ordre des clés n'a aucune importance en JSON.
 *
 * Une erreur survenant après les premiers octets ne peut plus changer le code
 * HTTP : on ferme alors le document avec `meta.erreur`, pour que l'appelant
 * détecte une réponse tronquée au lieu de la croire complète.
 */
function streamAllRows(
    req: NextRequest,
    filtres: Filtres,
    q: { enrich: string; fields?: string; fournisseur: string },
    freshness: { rowCount: number; computedAt: string | null },
    computedOnDemand: boolean,
): Response {
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const write = (s: string) => controller.enqueue(encoder.encode(s));
            let envoyees = 0;
            let total = 0;
            let computedAt: string | null = null;
            let erreur: string | null = null;

            write('{"data":[');
            try {
                for (let page = 1; ; page++) {
                    const lot = await queryGridRows({ ...filtres, page, limit: STREAM_BATCH });
                    if (page === 1) {
                        total = lot.total;
                        computedAt = lot.computedAt;
                    }
                    if (lot.rows.length === 0) break;

                    const enrichies = q.enrich === "1" ? await enrichRows(lot.rows) : lot.rows;
                    for (const r of enrichies) {
                        write((envoyees === 0 ? "" : ",") + JSON.stringify(pickFields(r, q.fields)));
                        envoyees++;
                    }
                    if (lot.rows.length < STREAM_BATCH) break;
                }
            } catch (e) {
                erreur = e instanceof Error ? e.message : String(e);
                console.error(`[api/v1/grid] diffusion interrompue pour ${q.fournisseur} après ${envoyees} lignes:`, erreur);
            }

            const complet = erreur === null && envoyees === total;
            write("]," + JSON.stringify({
                pagination: { page: 1, limit: envoyees, total, totalPages: 1, hasMore: !complet },
                meta: {
                    fournisseur: q.fournisseur,
                    computedAt,
                    snapshotComputedAt: freshness.computedAt,
                    snapshotRowCount: freshness.rowCount,
                    enrichi: q.enrich === "1",
                    computedOnDemand,
                    diffuse: true,
                    complet,
                    ...(erreur
                        ? { erreur: `Diffusion interrompue après ${envoyees} lignes sur ${total} : ${erreur}` }
                        : {}),
                },
            }).slice(1));
            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            // Empêche un proxy de tamponner la réponse entière avant de la relayer.
            "X-Accel-Buffering": "no",
        },
    });
}
