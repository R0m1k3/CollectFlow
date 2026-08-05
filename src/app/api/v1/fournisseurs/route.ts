import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { fournisseursQuerySchema } from "@/lib/api-schemas";
import { listGridSuppliers } from "@/lib/grid-store";
import { pgGetFournisseurs } from "@/lib/pg-ff-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/fournisseurs?search=…&withData=1
 *
 * Liste des fournisseurs. Par défaut, tout le référentiel (`fouident`), enrichi de la
 * fraîcheur de l'instantané de grille quand il existe — ce qui permet à l'appelant de
 * savoir d'avance quels fournisseurs `/api/v1/grid` peut servir immédiatement.
 *
 * `withData=1` restreint aux seuls fournisseurs déjà présents dans l'instantané.
 */
export async function GET(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const parsed = fournisseursQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        return fail("bad_request", "Paramètres invalides.", parsed.error.issues);
    }
    const { search, withData } = parsed.data;

    const snapshot = await listGridSuppliers();
    const byCode = new Map(snapshot.map((s) => [s.codeFournisseur, s]));

    if (withData === "1") {
        const term = search?.toLowerCase();
        const data = snapshot
            .filter((s) => !term
                || s.codeFournisseur.toLowerCase().includes(term)
                || (s.nomFournisseur ?? "").toLowerCase().includes(term))
            .map((s) => ({
                code: s.codeFournisseur,
                nom: s.nomFournisseur,
                hasSnapshot: true,
                rowCount: s.rowCount,
                computedAt: s.computedAt,
            }));
        return ok(data, { meta: { total: data.length, scope: "instantané uniquement" } });
    }

    const fournisseurs = await pgGetFournisseurs(search);
    const data = fournisseurs.map((f) => {
        const snap = byCode.get(f.code);
        return {
            code: f.code,
            nom: f.nom,
            hasSnapshot: Boolean(snap),
            rowCount: snap?.rowCount ?? 0,
            computedAt: snap?.computedAt ?? null,
        };
    });

    return ok(data, { meta: { total: data.length, withSnapshot: byCode.size } });
}
