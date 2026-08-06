import { NextResponse } from "next/server";
import { testFfApiConnection } from "@/features/settings/actions";

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
    const res = await testFfApiConnection();
    if (!res.success) {
        return NextResponse.json(
            { error: "API FF Nancy non disponible", url: res.url, detail: res.error },
            { status: 503 },
        );
    }
    return NextResponse.json(res.status);
}
