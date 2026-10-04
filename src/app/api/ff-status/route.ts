import { NextResponse } from "next/server";
import { diagnostiquerApiFf } from "@/features/settings/ff-api-diagnostic";
import { sessionOuReponse } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ff-status — état de l'API REST FF Nancy.
 *
 * S'appuie sur le même diagnostic que le bouton « Tester » des Paramètres, afin
 * qu'un échec dise *pourquoi* (DNS, connexion refusée, délai dépassé, code HTTP)
 * et *quelle adresse* a été appelée. L'ancienne version renvoyait un 503 sans
 * détail, impossible à distinguer d'une simple erreur d'URL.
 */
export async function GET() {
    const acces = await sessionOuReponse();
    if (acces instanceof Response) return acces;

    const res = await diagnostiquerApiFf();
    if (!res.success) {
        return NextResponse.json(
            { error: "API FF Nancy non disponible", url: res.url, detail: res.error },
            { status: 503 },
        );
    }
    return NextResponse.json(res.status);
}
