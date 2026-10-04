import { NextRequest, NextResponse } from "next/server";
import { sessionOuReponse } from "@/lib/authz";
import { pgGetOpportunitesFamille } from "@/lib/pg-ff-client";
import { buildLast12MonthsRange } from "@/lib/api-ff-client";

export const dynamic = "force-dynamic";

/**
 * GET /api/produits/opportunites?nomNoId=123
 *
 * Produits de la même nomenclature, classés par écart entre performance réseau
 * et performance locale (quantités par magasin). Chargé à la demande depuis la
 * fiche produit : la requête agrège `mvtart` sur 12 mois pour toute la famille,
 * on ne veut pas la payer au chargement de la page.
 */
export async function GET(req: NextRequest) {
    const acces = await sessionOuReponse();
    if (acces instanceof Response) return acces;

    const raw = req.nextUrl.searchParams.get("nomNoId");
    const nomNoId = Number(raw);
    if (!raw || !Number.isInteger(nomNoId) || nomNoId <= 0) {
        return NextResponse.json({ error: "Param 'nomNoId' invalide" }, { status: 400 });
    }

    try {
        const { dateDebut, dateFin } = buildLast12MonthsRange();
        const rows = await pgGetOpportunitesFamille(nomNoId, dateDebut, dateFin);
        return NextResponse.json({ success: true, rows });
    } catch (e) {
        console.error("[api/produits/opportunites]", (e as Error).message?.slice(0, 250));
        return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
    }
}
