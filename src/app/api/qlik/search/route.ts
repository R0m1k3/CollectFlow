import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { searchNetworkProductsPlaywright } from "@/lib/qlik-playwright";
import { upsertNetworkMetrics } from "@/lib/qlik-network-cache";
import { pgGetArticlesByCodeCentrale, pgGetStockForCodeins, type StockBySite } from "@/lib/pg-ff-client";
import { buildGridNetworkQlikDateFilter, envMonthsBack, QLIK_MONTHS_BACK_DEFAULT } from "@/lib/qlik-date-range";
import type { NetworkSearchJobState, NetworkSearchRow } from "@/types/network-search";

// Comme la sync : l'ouverture de l'app Qlik + les cubes peuvent prendre plusieurs
// dizaines de secondes. On rend la main immédiatement et le client polle GET.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchJob extends NetworkSearchJobState {
    jobId: string;
    status: "running" | "success" | "error";
}

/**
 * Store en mémoire (même parti pris que /api/qlik/sync : simple, perdu au restart).
 *
 * `activeJobId` sérialise les recherches : le moteur Qlik sature facilement, on ne
 * lance donc **qu'une extraction à la fois** pour toute l'application.
 */
const jobs = new Map<string, SearchJob>();
let activeJobId: string | null = null;

/** Ne garde que les N derniers jobs pour éviter une fuite mémoire. */
function pruneJobs(keep = 20): void {
    if (jobs.size <= keep) return;
    const ordered = [...jobs.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    for (const j of ordered.slice(0, jobs.size - keep)) {
        if (j.jobId !== activeJobId) jobs.delete(j.jobId);
    }
}

function newJobId(): string {
    return `qsearch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Vérifie qu'une session est ouverte. Renvoie une 401 sinon. */
async function requireSession(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return null;
}

/**
 * Traduit une erreur Qlik en message actionnable. La saturation mémoire du serveur
 * Qlik est le cas le plus fréquent et n'est PAS un bug CollectFlow : l'application
 * Qlik ne se charge même pas.
 */
function humanizeQlikError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes("out of memory") || lower.includes("not enough memory") || lower.includes("file corrupted") || lower.includes('"code":6') || lower.includes('"code":3002')) {
        return "Serveur Qlik saturé : mémoire insuffisante pour charger l'application. Réessayez plus tard (ou faites libérer / augmenter la RAM du serveur Qlik).";
    }
    return msg;
}

/** Exécute la recherche Qlik puis enrichit avec le catalogue local. */
async function runJob(job: SearchJob, maxProducts: number): Promise<void> {
    try {
        const monthsBack = envMonthsBack("QLIK_SYNC_MONTHS_BACK", QLIK_MONTHS_BACK_DEFAULT);
        const dateFilter = buildGridNetworkQlikDateFilter(new Date(), monthsBack);
        console.log(`[api/qlik/search] job=${job.jobId} query="${job.query}" fenêtre=${dateFilter.label}`);

        const res = await searchNetworkProductsPlaywright(job.query, { maxProducts }, undefined, dateFilter);
        job.mode = res.mode;
        job.matchCount = res.matchCount;
        job.periode = res.periode;

        if (res.tooMany) {
            job.tooMany = true;
            job.results = [];
            job.status = "success";
            job.finishedAt = new Date().toISOString();
            console.log(`[api/qlik/search] job=${job.jobId} recherche trop large (${res.matchCount} > ${maxProducts})`);
            return;
        }

        const products = res.products;
        console.log(`[api/qlik/search] job=${job.jobId} ← Qlik: ${products.length} produits`);

        // Mise en cache : accélère les recherches suivantes ET enrichit la Grille
        // pour les codes que nous référençons.
        if (products.length) {
            try {
                const n = await upsertNetworkMetrics(products);
                console.log(`[api/qlik/search] job=${job.jobId} ${n} lignes mises en cache`);
            } catch (e) {
                // Non fatal : la recherche reste exploitable sans cache.
                console.error(`[api/qlik/search] job=${job.jobId} cache KO:`, e instanceof Error ? e.message : String(e));
            }
        }

        // Enrichissement local : qui connaît-on déjà, et avec quel stock ?
        const locaux = await pgGetArticlesByCodeCentrale(products.map((p) => p.codeCentrale));
        const codeins = [...locaux.values()].map((a) => a.codein).filter(Boolean);
        const stocks: Map<string, StockBySite> = codeins.length
            ? await pgGetStockForCodeins(codeins)
            : new Map<string, StockBySite>();

        const rows: NetworkSearchRow[] = products.map((p) => {
            const local = locaux.get(p.codeCentrale);
            const stock = local?.codein ? stocks.get(local.codein) : undefined;
            return {
                codeCentrale: p.codeCentrale,
                libelle: p.libelle || local?.libelle1 || p.codeCentrale,
                fournisseur: p.fournisseur,
                famille: p.famille,
                caReseau: p.caReseau,
                qteReseau: p.qteReseau,
                nbMagasinsReseau: p.nbMagasinsReseau,
                caParMagasinReseau: p.caParMagasinReseau,
                margePctReseau: p.margePctReseau,
                qteByMonth: p.qteByMonth ?? null,
                chezMoi: Boolean(local),
                codein: local?.codein,
                libelleLocal: local?.libelle1,
                codefou: local?.codefou,
                nomfou: local?.nomfou,
                pa: local?.pa != null ? Number(local.pa) : undefined,
                pvCentral: local?.pv_central != null ? Number(local.pv_central) : undefined,
                stock292: stock?.stock292,
                stock579: stock?.stock579,
                stockTotal: stock?.stockTotal,
            };
        });

        job.results = rows;
        job.status = "success";
        job.finishedAt = new Date().toISOString();
        console.log(`[api/qlik/search] job=${job.jobId} terminé — ${rows.length} lignes (${rows.filter((r) => r.chezMoi).length} déjà référencées)`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[api/qlik/search] job=${job.jobId}`, msg);
        job.status = "error";
        job.error = humanizeQlikError(msg);
        job.finishedAt = new Date().toISOString();
    } finally {
        if (activeJobId === job.jobId) activeJobId = null;
        pruneJobs();
    }
}

/**
 * GET /api/qlik/search?jobId=XXX
 * État + résultats du job. Sans jobId, renvoie le job actif s'il y en a un.
 */
export async function GET(req: NextRequest) {
    const denied = await requireSession();
    if (denied) return denied;

    const jobId = req.nextUrl.searchParams.get("jobId");
    const job = jobId ? jobs.get(jobId) : (activeJobId ? jobs.get(activeJobId) : undefined);
    if (!job) {
        const idle: NetworkSearchJobState = { jobId: null, status: "idle", query: "" };
        return NextResponse.json({ success: true, ...idle });
    }
    return NextResponse.json({ success: true, ...job });
}

/**
 * POST /api/qlik/search  body: { query: string, maxProducts?: number }
 * Démarre une recherche en arrière-plan et retourne immédiatement le job.
 * Refuse (409) si une recherche tourne déjà — le moteur Qlik ne supporte pas
 * plusieurs extractions concurrentes.
 */
export async function POST(req: NextRequest) {
    const denied = await requireSession();
    if (denied) return denied;

    let body: { query?: unknown; maxProducts?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
    }

    const query = String(body.query ?? "").trim();
    if (!query) return NextResponse.json({ error: "Param 'query' requis" }, { status: 400 });
    if (query.length > 120) return NextResponse.json({ error: "Recherche trop longue (120 caractères max)" }, { status: 400 });

    const rawMax = Number(body.maxProducts);
    const maxProducts = Number.isFinite(rawMax) ? Math.min(2000, Math.max(1, Math.trunc(rawMax))) : 300;

    const active = activeJobId ? jobs.get(activeJobId) : undefined;
    if (active && active.status === "running") {
        return NextResponse.json(
            { error: `Une recherche est déjà en cours ("${active.query}"). Attendez qu'elle se termine.`, ...active },
            { status: 409 },
        );
    }

    const job: SearchJob = {
        jobId: newJobId(),
        status: "running",
        query,
        maxProducts,
        startedAt: new Date().toISOString(),
    };
    jobs.set(job.jobId, job);
    activeJobId = job.jobId;
    console.log(`[api/qlik/search] job=${job.jobId} démarré — query="${query}" max=${maxProducts}`);

    // Fire-and-forget : le client polle GET. runJob capture ses propres erreurs.
    void runJob(job, maxProducts).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[api/qlik/search] job=${job.jobId} crash non géré`, msg);
        job.status = "error";
        job.error = msg;
        job.finishedAt = new Date().toISOString();
        if (activeJobId === job.jobId) activeJobId = null;
    });

    return NextResponse.json({ success: true, ...job });
}
