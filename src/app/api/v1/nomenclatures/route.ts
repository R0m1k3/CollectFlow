import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { nomenclaturesQuerySchema } from "@/lib/api-schemas";
import { listGridNomenclatures, getGridFreshness } from "@/lib/grid-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/nomenclatures?fournisseur=…&niveau=1|2|3&parent=…
 *
 * Répartition des articles d'un fournisseur par poste de nomenclature, avec le
 * nombre d'articles et le CA de chacun.
 *
 * C'est la porte d'entrée pour traiter un gros fournisseur : certains dépassent
 * 130 000 articles, et tout récupérer d'un coup n'a de sens ni pour une IA ni
 * pour une application. On liste d'abord les postes — quelques dizaines de
 * lignes — puis on interroge `/grid?fournisseur=…&code1=…` poste par poste.
 *
 * `niveau=2` accepte `parent` (un code1) et `niveau=3` un `parent` (un code2),
 * pour descendre l'arborescence sans tout charger.
 */
export async function GET(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const parsed = nomenclaturesQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
        return fail("bad_request", "Paramètres invalides.", parsed.error.issues);
    }
    const { fournisseur, niveau, parent } = parsed.data;

    // Même distinction que /grid : « pas encore calculé » n'est pas « vide ».
    const freshness = await getGridFreshness(fournisseur);
    if (!freshness) {
        return fail(
            "not_ready",
            `Aucun instantané pour le fournisseur « ${fournisseur} ». Appelez /api/v1/grid?fournisseur=${fournisseur} une fois pour le calculer.`,
            { fournisseur },
        );
    }

    const postes = await listGridNomenclatures(fournisseur, niveau, parent);
    const nbArticles = postes.reduce((s, p) => s + p.nbArticles, 0);

    return ok(postes, {
        meta: {
            fournisseur,
            niveau,
            parent: parent ?? null,
            nbPostes: postes.length,
            /** Total couvert par les postes listés — à rapprocher de snapshotRowCount. */
            nbArticles,
            snapshotRowCount: freshness.rowCount,
            snapshotComputedAt: freshness.computedAt,
            /** Le paramètre de /grid à utiliser pour filtrer sur un poste de ce niveau. */
            filtreGrid: `code${niveau}`,
        },
    });
}
