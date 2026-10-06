import { NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { ok, fail } from "@/lib/api-response";
import { gammesBatchBodySchema } from "@/lib/api-schemas";
import { affecterGammes, lireCorpsJson } from "@/lib/api-gammes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Idem /api/v1/grid : le calcul à la demande peut prendre plusieurs secondes.
export const maxDuration = 300;

/**
 * POST /api/v1/gammes   { "fournisseur": "…", "changes": [{ "codein": "…", "gamme": "A" }, …] }
 *
 * Propose la gamme de plusieurs articles d'un fournisseur en un appel. Les
 * propositions restent **à valider** dans la Grille (cf. lib/api-gammes).
 * Tout ou rien : un article inconnu chez le fournisseur fait échouer l'appel (404).
 */
export async function POST(req: NextRequest) {
    const authCtx = await requireApiAuth(req);
    if (authCtx instanceof Response) return authCtx;

    const corps = await lireCorpsJson(req);
    if (corps instanceof Response) return corps;
    const parsed = gammesBatchBodySchema.safeParse(corps);
    if (!parsed.success) {
        return fail("bad_request", "Corps de requête invalide.", parsed.error.issues);
    }
    const { fournisseur, changes, compute } = parsed.data;

    const res = await affecterGammes({
        codeFournisseur: fournisseur,
        changes,
        compute,
        auteur: authCtx.subject,
    });
    if (res instanceof Response) return res;

    return ok(res.resultats, {
        meta: {
            codeFournisseur: res.codeFournisseur,
            nomFournisseur: res.nomFournisseur,
            demandes: res.resultats.length,
            modifies: res.resultats.filter((r) => r.modifie).length,
            aValider: res.resultats.filter((r) => r.statut === "a_valider").length,
            enregistreLe: new Date().toISOString(),
        },
    });
}
