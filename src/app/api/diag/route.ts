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
        let summary: unknown = parsed;
        if (Array.isArray(parsed)) {
            summary = { count: parsed.length, firstKeys: parsed[0] ? Object.keys(parsed[0]) : [], sample: parsed.slice(0, 2) };
        } else if (parsed && typeof parsed === "object") {
            const keys = Object.keys(parsed as object);
            const firstArrayKey = keys.find(k => Array.isArray((parsed as Record<string, unknown>)[k]));
            if (firstArrayKey) {
                const arr = (parsed as Record<string, unknown[]>)[firstArrayKey];
                summary = { wrapper: firstArrayKey, count: arr.length, firstKeys: arr[0] ? Object.keys(arr[0] as object) : [], sample: arr.slice(0, 2) };
            } else {
                // Objet simple : montrer toutes les clés et le contenu complet
                summary = { keys, full: parsed };
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

    // Récupérer un codefou réel + un codein réel depuis l'API
    let codefou = searchParams.get("codefou");
    let firstCodein: string | null = searchParams.get("codein");

    if (!codefou) {
        try {
            const res = await fetch(`${FF_API_BASE}/api/fournisseurs?limit=1`, { cache: "no-store" });
            const data = await res.json();
            const list = Array.isArray(data) ? data : (Object.values(data).find(v => Array.isArray(v)) as unknown[] ?? []);
            if (list.length > 0) codefou = (list[0] as Record<string, unknown>).codefou as string ?? null;
        } catch { /* ignore */ }
        codefou ??= "D005";
    }

    if (!firstCodein) {
        try {
            const res = await fetch(`${FF_API_BASE}/api/articles?codefou=${codefou}&limit=1`, { cache: "no-store" });
            const data = await res.json();
            const list = Array.isArray(data) ? data : (Object.values(data).find(v => Array.isArray(v)) as unknown[] ?? []);
            if (list.length > 0) firstCodein = (list[0] as Record<string, unknown>).codein as string ?? null;
        } catch { /* ignore */ }
    }

    const [
        fournisseurs,
        articles,
        mvt_dateDebut,
        // Nouveaux endpoints
        mensuel_codein,
        mensuel_noid,
        stock_periode,
        mvt_types,
    ] = await Promise.all([
        probe(`${FF_API_BASE}/api/fournisseurs?limit=2`),
        probe(`${FF_API_BASE}/api/articles?codefou=${codefou}&limit=2`),
        probe(`${FF_API_BASE}/api/mouvements/articles?codefou=${codefou}&dateDebut=${dateDebut}&dateFin=${dateFin}&limit=2`),
        // Test mensuel avec codein
        firstCodein
            ? probe(`${FF_API_BASE}/api/articles/${encodeURIComponent(firstCodein)}/mensuel?dateDebut=${dateDebut}&dateFin=${dateFin}`)
            : Promise.resolve({ skipped: "no codein available" }),
        // Test mensuel avec no_id (si dispo)
        firstCodein
            ? (async () => {
                try {
                    const res = await fetch(`${FF_API_BASE}/api/articles?codefou=${codefou}&limit=1`, { cache: "no-store" });
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (Object.values(data).find(v => Array.isArray(v)) as unknown[] ?? []);
                    const noid = list[0] ? (list[0] as Record<string, unknown>).no_id as string : null;
                    if (noid) return probe(`${FF_API_BASE}/api/articles/${encodeURIComponent(noid)}/mensuel?dateDebut=${dateDebut}&dateFin=${dateFin}`);
                } catch { /* ignore */ }
                return { skipped: "no no_id available" };
            })()
            : Promise.resolve({ skipped: "no article" }),
        // Test stock/periode
        firstCodein
            ? probe(`${FF_API_BASE}/api/stock/article/${encodeURIComponent(firstCodein!)}/periode?dateDebut=${dateDebut}&dateFin=${dateFin}`)
            : Promise.resolve({ skipped: "no codein available" }),
        probe(`${FF_API_BASE}/api/mouvements/types`),
    ]);

    // Test PostgreSQL + diagnostic ventesProduits
    let postgresql: unknown;
    let ventesProduitsDiag: unknown;
    try {
        const r = await db.execute(sql`SELECT COUNT(*) as count FROM session_snapshots`);

        // Diagnostic ventesProduits : cherche par les 2 codes possibles d'AUXENCE
        const vpByName = await db.execute(sql`
            SELECT code_fournisseur, COUNT(*) as nb_rows,
                   COUNT(code_gamme) as nb_gamme,
                   COUNT(code_gamme_init) as nb_gamme_init,
                   COUNT(code3) as nb_code3
            FROM ventes_produits
            WHERE code_fournisseur IN ('AUXENCE', 'A025', ${codefou})
            GROUP BY code_fournisseur
        `);

        // Sample de quelques codeins dans ventesProduits pour ce fournisseur
        const vpSample = await db.execute(sql`
            SELECT codein, code_fournisseur, code_gamme, code_gamme_init, code3, libelle3
            FROM ventes_produits
            WHERE code_fournisseur IN ('AUXENCE', 'A025', ${codefou})
            LIMIT 3
        `);

        postgresql = {
            ok: true,
            snapshots: Number(r.rows[0]?.count ?? 0),
        };
        ventesProduitsDiag = {
            byFournisseur: vpByName.rows,
            sample: vpSample.rows,
        };
    } catch (e) {
        postgresql = { ok: false, error: String(e) };
        ventesProduitsDiag = { error: String(e) };
    }

    return NextResponse.json({
        timestamp: new Date().toISOString(),
        dateRange: { dateDebut, dateFin },
        codefouTested: codefou,
        firstCodeinTested: firstCodein,
        fournisseurs,
        articles,
        mouvements_dateDebut: mvt_dateDebut,
        nouveaux_endpoints: {
            "articles/:codein/mensuel": mensuel_codein,
            "articles/:no_id/mensuel": mensuel_noid,
            "stock/article/:codein/periode": stock_periode,
            "mouvements/types": mvt_types,
        },
        postgresql,
        ventesProduitsDiag,
    });
}
