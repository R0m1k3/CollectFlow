import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail, buildPagination } from "@/lib/api-response";
import { gridQuerySchema, pickFields, toSortKey } from "@/lib/api-schemas";
import { queryGridRows, getGridFreshness } from "@/lib/grid-store";
import { enrichRows } from "@/lib/api-enrich";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/grid?fournisseur=…&gamme=&code1..3=&search=&sort=&order=&page=&limit=&fields=
 *
 * Lignes de grille d'un fournisseur, filtrées / triées / paginées **en SQL** depuis
 * l'instantané persisté (`grid_rows`).
 *
 * Cet endpoint ne déclenche **jamais** `getProductRows()` et ne contacte jamais Qlik :
 * si le fournisseur n'a pas encore d'instantané, il répond `202 not_ready` plutôt que
 * d'imposer un calcul de plusieurs secondes à l'appelant.
 */
export async function GET(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const parsed = gridQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        return fail("bad_request", "Paramètres invalides.", parsed.error.issues);
    }
    const q = parsed.data;

    // Distingue « fournisseur jamais calculé » (202) de « filtres sans résultat » (200 vide).
    const freshness = await getGridFreshness(q.fournisseur);
    if (!freshness) {
        return fail(
            "not_ready",
            `Aucun instantané pour le fournisseur « ${q.fournisseur} ». Ouvrez-le une fois dans la Grille pour le calculer.`,
            { fournisseur: q.fournisseur },
        );
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

    return ok(
        rows.map((r) => pickFields(r, q.fields)),
        {
            pagination: buildPagination(q.page, q.limit, result.total),
            meta: {
                fournisseur: q.fournisseur,
                computedAt: result.computedAt,
                snapshotComputedAt: freshness.computedAt,
                snapshotRowCount: freshness.rowCount,
                enrichi: q.enrich === "1",
            },
        },
    );
}
