import { NextResponse } from "next/server";
import { pgDiagFournisseurDerniereEntree } from "@/lib/pg-ff-client";

export const dynamic = "force-dynamic";

/**
 * Diagnostic de l'attribution « fournisseur de la dernière entrée » utilisée par
 * la page Gestion de Stock.
 *
 * `colonneDetectee: null` signifie que `mvtart` ne porte aucune des colonnes
 * fournisseur connues : la page retombe alors sur `artfou1.preference = 1`.
 * `colonnesMvtart` liste ce qui existe réellement, pour compléter la liste
 * blanche `MVTART_FOU_CANDIDATES` si le nom diffère.
 */
export async function GET() {
    try {
        return NextResponse.json(await pgDiagFournisseurDerniereEntree());
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
