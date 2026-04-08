import { NextResponse } from "next/server";
import { pgGetCommandesAuto } from "@/lib/pg-ff-client";

/**
 * GET /api/commandes-auto
 *
 * Retourne la liste des fournisseurs en commande automatique,
 * groupés par site (292, 579), avec franco et écart franco.
 *
 * Réponse :
 * [
 *   {
 *     site: "292",
 *     codefou: "FOU123",
 *     nomfou: "Nom Fournisseur",
 *     franco: 500,
 *     nb_articles: 12,
 *     montant_cde: 620.50,
 *     franco_atteint: true,
 *     ecart_franco: -120.50
 *   },
 *   ...
 * ]
 */
export async function GET() {
    try {
        const rows = await pgGetCommandesAuto();
        return NextResponse.json(rows);
    } catch (e) {
        console.error("[api/commandes-auto]", e);
        return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
    }
}
