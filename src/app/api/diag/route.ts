import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";

async function probe(url: string) {
    try {
        const res = await fetch(url, { cache: "no-store" });
        const text = await res.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 800); }
        // Résumé: nb items si tableau, ou clés si objet
        let summary: unknown = parsed;
        if (Array.isArray(parsed)) {
            summary = { count: parsed.length, firstKeys: parsed[0] ? Object.keys(parsed[0]) : [], sample: parsed.slice(0, 2) };
        } else if (parsed && typeof parsed === "object") {
            const keys = Object.keys(parsed as object);
            const firstArrayKey = keys.find(k => Array.isArray((parsed as Record<string, unknown>)[k]));
            if (firstArrayKey) {
                const arr = (parsed as Record<string, unknown[]>)[firstArrayKey];
                summary = { wrapper: firstArrayKey, count: arr.length, firstKeys: arr[0] ? Object.keys(arr[0] as object) : [], sample: arr.slice(0, 2) };
            }
        }
        return { status: res.status, url, summary };
    } catch (e) {
        return { error: String(e), url };
    }
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);

    // Date range: 12 derniers mois
    const now = new Date();
    const dateFin = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
    const dateDebut = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString().slice(0, 10);

    // Récupérer le premier codefou réel depuis l'API (si pas fourni en param)
    let codefou = searchParams.get("codefou");
    if (!codefou) {
        try {
            const res = await fetch(`${FF_API_BASE}/api/fournisseurs?limit=1`, { cache: "no-store" });
            const data = await res.json();
            const list = Array.isArray(data) ? data : (Object.values(data).find(v => Array.isArray(v)) as unknown[] ?? []);
            if (list.length > 0) codefou = (list[0] as Record<string, unknown>).codefou as string ?? null;
        } catch { /* ignore */ }
        codefou ??= "D001";
    }

    const [
        fournisseurs,
        articles,
        // Tester plusieurs variantes de noms de paramètres pour les mouvements
        mvt_datedeb,
        mvt_dateDebut,
        mvt_from,
        mvt_nodate,
    ] = await Promise.all([
        probe(`${FF_API_BASE}/api/fournisseurs?limit=3`),
        probe(`${FF_API_BASE}/api/articles?codefou=${codefou}&limit=3`),
        probe(`${FF_API_BASE}/api/mouvements/articles?codefou=${codefou}&datedeb=${dateDebut}&datefin=${dateFin}&limit=3`),
        probe(`${FF_API_BASE}/api/mouvements/articles?codefou=${codefou}&dateDebut=${dateDebut}&dateFin=${dateFin}&limit=3`),
        probe(`${FF_API_BASE}/api/mouvements/articles?codefou=${codefou}&from=${dateDebut}&to=${dateFin}&limit=3`),
        probe(`${FF_API_BASE}/api/mouvements/articles?codefou=${codefou}&limit=3`),
    ]);

    // Test PostgreSQL
    let postgresql: unknown;
    try {
        const r = await db.execute(sql`SELECT COUNT(*) as count FROM session_snapshots`);
        postgresql = { ok: true, snapshots: Number(r.rows[0]?.count ?? 0) };
    } catch (e) {
        postgresql = { ok: false, error: String(e) };
    }

    return NextResponse.json({
        timestamp: new Date().toISOString(),
        env: {
            FF_API_BASE_URL: process.env.FF_API_BASE_URL ?? "(not set — default used)",
            FF_API_BASE_resolved: FF_API_BASE,
        },
        dateRange: { dateDebut, dateFin },
        codefouTested: codefou,
        fournisseurs,
        articles,
        mouvements: {
            "datedeb/datefin": mvt_datedeb,
            "dateDebut/dateFin": mvt_dateDebut,
            "from/to": mvt_from,
            "no_date": mvt_nodate,
        },
        postgresql,
    });
}
