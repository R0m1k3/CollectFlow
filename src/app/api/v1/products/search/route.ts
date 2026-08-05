import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail, buildPagination } from "@/lib/api-response";
import { productSearchSchema, pickFields, toSortKey } from "@/lib/api-schemas";
import { queryGridRows } from "@/lib/grid-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/products/search?q=…&fournisseur=&gamme=&sort=&order=&page=&limit=&fields=
 *
 * **Recherche transversale** sur libellé, codein, GTIN, référence et code centrale —
 * tous fournisseurs confondus. C'est ce qu'aucune route existante ne sait faire :
 * `getProductRows()` exige un fournisseur, donc chercher un produit sans le connaître
 * était impossible.
 *
 * Lit uniquement l'instantané `grid_rows` : un fournisseur jamais ouvert dans la
 * Grille n'apparaît pas encore dans les résultats.
 */
export async function GET(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const parsed = productSearchSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        return fail("bad_request", "Paramètres invalides.", parsed.error.issues);
    }
    const q = parsed.data;

    const result = await queryGridRows({
        codeFournisseur: q.fournisseur,
        gamme: q.gamme,
        search: q.q,
        sort: toSortKey(q.sort),
        order: q.order,
        page: q.page,
        limit: q.limit,
    });

    return ok(
        result.rows.map((r) => pickFields(r, q.fields)),
        {
            pagination: buildPagination(q.page, q.limit, result.total),
            meta: {
                query: q.q,
                computedAt: result.computedAt,
                scope: q.fournisseur ? `fournisseur:${q.fournisseur}` : "tous fournisseurs",
            },
        },
    );
}
