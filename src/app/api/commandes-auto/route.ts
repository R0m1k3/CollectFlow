import { NextRequest, NextResponse } from "next/server";

const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";

/**
 * GET /api/commandes-auto[?site=292&codefou=N009]
 *
 * Proxy vers https://api.ffnancy.fr/api/commandes-auto
 * Transfère les query params site et codefou si présents.
 */
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = req.nextUrl;
        const params = new URLSearchParams();
        if (searchParams.get("site"))    params.set("site",    searchParams.get("site")!);
        if (searchParams.get("codefou")) params.set("codefou", searchParams.get("codefou")!);

        const qs = params.toString();
        const url = `${FF_API_BASE}/api/commandes-auto${qs ? `?${qs}` : ""}`;

        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
            return NextResponse.json({ error: `API upstream HTTP ${res.status}` }, { status: res.status });
        }
        const data = await res.json();
        return NextResponse.json(data);
    } catch (e) {
        console.error("[api/commandes-auto]", e);
        return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
    }
}
