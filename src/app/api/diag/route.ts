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
    const forcedNoid = searchParams.get("noid"); // ex: ?noid=129632

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

    // Si un noid est forcé, on probe directement mensuel + referentiel pour cet article
    const mensuelNoidForced = forcedNoid
        ? probe(`${FF_API_BASE}/api/articles/${encodeURIComponent(forcedNoid)}/mensuel?dateDebut=${dateDebut}&dateFin=${dateFin}`)
        : Promise.resolve({ skipped: "no ?noid= param" });
    const referentielNoidForced = forcedNoid
        ? probe(`${FF_API_BASE}/api/articles/${encodeURIComponent(forcedNoid)}/referentiel`)
        : Promise.resolve({ skipped: "no ?noid= param" });

    const [
        fournisseurs,
        articles,
        mvt_dateDebut,
        mensuel_noid,
        referentiel,
        mensuel_forced,
        referentiel_forced,
    ] = await Promise.all([
        probe(`${FF_API_BASE}/api/fournisseurs?limit=2`),
        probe(`${FF_API_BASE}/api/articles?codefou=${codefou}&limit=2`),
        probe(`${FF_API_BASE}/api/mouvements/articles?codefou=${codefou}&dateDebut=${dateDebut}&dateFin=${dateFin}&limit=2`),
        // Test mensuel avec no_id auto-résolu
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
        // Referentiel complet (nomenclature + gamme + stock + prix)
        firstCodein
            ? (async () => {
                try {
                    const res = await fetch(`${FF_API_BASE}/api/articles?codefou=${codefou}&limit=5`, { cache: "no-store" });
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (Object.values(data).find(v => Array.isArray(v)) as unknown[] ?? []);
                    const art = (list[4] ?? list[0]) as Record<string, unknown> | undefined;
                    const noId = art?.no_id as string ?? null;
                    if (noId) return probe(`${FF_API_BASE}/api/articles/${encodeURIComponent(noId)}/referentiel`);
                } catch { /* ignore */ }
                return { skipped: "no no_id" };
            })()
            : Promise.resolve({ skipped: "no codefou" }),
        mensuelNoidForced,
        referentielNoidForced,
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

    // Diagnostic analytics CA TTC
    let mvtartDiag: unknown;
    try {
        // 1. Totaux mars 2025 avec mntmvtht et mntmvtttc pour comparer avec API (HT=225k, TTC=269k)
        const totaux = await db.execute(sql`
            SELECT site,
                   ABS(SUM(mntmvtht))::float   AS sum_ht,
                   ABS(SUM(mntmvtttc))::float  AS sum_ttc,
                   COUNT(*) AS nb_lignes
            FROM mvtart
            WHERE genremvt = 3
              AND TO_CHAR(datmvt, 'YYYY-MM') = '2025-03'
              AND site IN ('292', '579')
            GROUP BY site
        `);
        // 2. Distribution des valeurs de preference dans artfou1
        const prefDist = await db.execute(sql`
            SELECT preference, COUNT(*) AS nb
            FROM artfou1
            GROUP BY preference
            ORDER BY preference
        `);
        // 3. Ventes mars 2025 non attribuées (aucune ligne artfou1 avec preference=1)
        const sansPreference = await db.execute(sql`
            SELECT COUNT(DISTINCT m.artnoid) AS nb_articles_sans_pref
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            WHERE m.genremvt = 3
              AND TO_CHAR(m.datmvt, 'YYYY-MM') = '2025-03'
              AND m.site IN ('292','579')
              AND NOT EXISTS (
                  SELECT 1 FROM artfou1 af
                  WHERE af.art_no_id = a.no_id AND af.preference = 1
              )
        `);
        mvtartDiag = {
            totaux_202503: totaux.rows,
            artfou1_preference_distribution: prefDist.rows,
            articles_vendus_sans_pref1: sansPreference.rows,
        };
    } catch (e) {
        mvtartDiag = { error: String(e) };
    }

    return NextResponse.json({
        timestamp: new Date().toISOString(),
        dateRange: { dateDebut, dateFin },
        codefouTested: codefou,
        firstCodeinTested: firstCodein,
        forcedNoid: forcedNoid ?? "(none — pass ?noid=129632 to test a specific article)",
        fournisseurs,
        articles,
        mouvements_dateDebut: mvt_dateDebut,
        endpoints_auto: {
            "articles/:no_id/mensuel": mensuel_noid,
            "articles/:no_id/referentiel": referentiel,
        },
        endpoints_forced_noid: {
            "articles/:noid/mensuel": mensuel_forced,
            "articles/:noid/referentiel": referentiel_forced,
        },
        postgresql,
        ventesProduitsDiag,
        mvtartDiag,
    });
}
