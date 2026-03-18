import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const target = searchParams.get("target") ?? "all";

    const result: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        env: {
            FF_API_BASE_URL: process.env.FF_API_BASE_URL ?? "(not set — using default)",
            FF_API_BASE_resolved: FF_API_BASE,
            NODE_ENV: process.env.NODE_ENV,
        },
    };

    // ── Test FF Nancy API ────────────────────────────────────────────────────
    if (target === "all" || target === "ff") {
        const ffTests: Record<string, unknown> = {};

        // Test fournisseurs
        try {
            const url = `${FF_API_BASE}/api/fournisseurs?limit=5`;
            const res = await fetch(url, { cache: "no-store" });
            const text = await res.text();
            let parsed: unknown = null;
            try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }
            ffTests.fournisseurs = { status: res.status, url, raw: parsed };
        } catch (e) {
            ffTests.fournisseurs = { error: String(e) };
        }

        // Test articles (avec un code fournisseur de test)
        const codefou = searchParams.get("codefou");
        if (codefou) {
            try {
                const url = `${FF_API_BASE}/api/articles?codefou=${codefou}&limit=3`;
                const res = await fetch(url, { cache: "no-store" });
                const text = await res.text();
                let parsed: unknown = null;
                try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }
                ffTests.articles = { status: res.status, url, raw: parsed };
            } catch (e) {
                ffTests.articles = { error: String(e) };
            }
        }

        result.ffNancyApi = ffTests;
    }

    // ── Test PostgreSQL ──────────────────────────────────────────────────────
    if (target === "all" || target === "db") {
        try {
            const countResult = await db.execute(sql`SELECT COUNT(*) as count FROM session_snapshots`);
            result.postgresql = { ok: true, snapshots: Number(countResult.rows[0]?.count ?? 0) };
        } catch (e) {
            result.postgresql = { ok: false, error: String(e) };
        }
    }

    return NextResponse.json(result, { status: 200 });
}
