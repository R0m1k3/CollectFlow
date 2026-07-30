import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { demarrerRecherche, etatRecherche } from "@/features/produits/api/search-produits";

// Les réponses sont immédiates (le travail Qlik tourne en tâche de fond), mais on
// garde le runtime Node.js : Playwright/Chromium ne tourne pas en edge, et l'état
// des jobs vit dans la mémoire du process.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recherche produit **Qlik d'abord** — API asynchrone.
 *
 * `POST /api/produits/search?q=<terme>[&force=1]` démarre la recherche et rend la
 * main tout de suite. `GET /api/produits/search?q=<terme>` renvoie l'avancement,
 * puis le résultat.
 *
 * Pourquoi asynchrone : une recherche enchaîne deux allers-retours Qlik (dont une
 * extraction mensuelle) et peut dépasser la minute. Une requête HTTP maintenue
 * aussi longtemps se fait couper par le reverse proxy, qui répond une page
 * d'erreur **HTML** — le client échouait alors sur « Unexpected token '<' … is
 * not valid JSON ». Même schéma que `POST /api/qlik/sync`.
 *
 * Le middleware Next ne protège pas `/api/*` : contrôle de session explicite.
 */

async function requireSession(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return null;
}

function lireTerme(req: NextRequest): string | null {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    return q.length >= 3 ? q : null;
}

export async function POST(req: NextRequest) {
    const denied = await requireSession();
    if (denied) return denied;

    const q = lireTerme(req);
    if (!q) return NextResponse.json({ error: "Saisissez au moins 3 caractères" }, { status: 400 });

    const force = req.nextUrl.searchParams.get("force") === "1";
    try {
        const job = demarrerRecherche(q, { force });
        return NextResponse.json({ success: true, ...job });
    } catch (e) {
        const message = (e as Error).message ?? String(e);
        console.error("[api/produits/search] POST", message.slice(0, 300));
        return NextResponse.json({ error: message.slice(0, 300) }, { status: 500 });
    }
}

export async function GET(req: NextRequest) {
    const denied = await requireSession();
    if (denied) return denied;

    const q = lireTerme(req);
    if (!q) return NextResponse.json({ error: "Saisissez au moins 3 caractères" }, { status: 400 });

    try {
        return NextResponse.json({ success: true, ...etatRecherche(q) });
    } catch (e) {
        const message = (e as Error).message ?? String(e);
        console.error("[api/produits/search] GET", message.slice(0, 300));
        return NextResponse.json({ error: message.slice(0, 300) }, { status: 500 });
    }
}
