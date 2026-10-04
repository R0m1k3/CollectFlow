import { NextRequest } from "next/server";
import { getStorePatch } from "@/features/grid/api/get-product-rows";
import { MAGASINS } from "@/lib/magasins";
import { sessionOuReponse } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * GET /api/grid/rows/store-patch?fournisseur=…&magasin=…
 *
 * Complément de l'API FF pour un magasin (cf. `features/grid/lib/store-patch.ts`).
 * La Grille charge toujours les lignes « tous magasins » et applique ce
 * complément à son arrivée : le changement de magasin n'attend plus rien.
 */
export async function GET(request: NextRequest) {
    const acces = await sessionOuReponse();
    if (acces instanceof Response) return acces;

    const codeFournisseur = request.nextUrl.searchParams.get("fournisseur");
    const magasin = request.nextUrl.searchParams.get("magasin") ?? "";
    // Un code inconnu ferait de chaque article un candidat : autant d'appels
    // inutiles à l'API FF. « Tous magasins » n'a pas de complément.
    if (!codeFournisseur || !MAGASINS.some((m) => m.code === magasin)) {
        return Response.json({ error: "Paramètres fournisseur et magasin requis." }, { status: 400 });
    }

    try {
        const patch = await getStorePatch(codeFournisseur, magasin);
        return Response.json(patch, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.error(`[store-patch] ${codeFournisseur}/${magasin} KO:`, (error as Error).message?.slice(0, 200));
        return Response.json({ error: "Complément indisponible." }, { status: 502 });
    }
}
