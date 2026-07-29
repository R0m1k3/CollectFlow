import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rechercherProduits } from "@/features/produits/api/search-produits";

// L'extraction Qlik (Playwright + Engine) prend plusieurs secondes, parfois
// plus d'une minute quand le serveur Qlik est chargé.
export const maxDuration = 300;
// Playwright/Chromium exige le runtime Node.js (pas edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/produits/search?q=<terme>[&force=1]
 *
 * Recherche produit **Qlik d'abord** : les articles du réseau qui correspondent
 * au terme, leurs métriques réseau sur 12 mois glissants, puis le rapprochement
 * avec le catalogue FF Nancy.
 *
 * `force=1` ignore le cache mémoire de 10 min (bouton « relancer »).
 *
 * Le middleware Next ne protège pas `/api/*` : contrôle de session explicite.
 */
export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    if (q.length < 3) {
        return NextResponse.json({ error: "Saisissez au moins 3 caractères" }, { status: 400 });
    }
    const force = req.nextUrl.searchParams.get("force") === "1";

    try {
        const result = await rechercherProduits(q, { force });
        return NextResponse.json({ success: true, ...result });
    } catch (e) {
        const message = (e as Error).message ?? String(e);
        console.error("[api/produits/search]", message.slice(0, 300));
        return NextResponse.json({ error: message.slice(0, 300) }, { status: 500 });
    }
}
