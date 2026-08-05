import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pgGetFournisseurs } from "@/lib/pg-ff-client";
import { getProductRows } from "@/features/grid/api/get-product-rows";
import { listGridSuppliers } from "@/lib/grid-store";

// Le préchauffage parcourt tous les fournisseurs : c'est long par nature. On rend la
// main immédiatement et le client interroge GET pour suivre l'avancement.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Préchauffage de l'instantané de grille (`grid_rows`).
 *
 * L'API `/api/v1` ne calcule jamais : elle lit un instantané écrit quand la Grille est
 * ouverte dans l'application. Sans préchauffage, un consommateur externe (ChatGPT) ne
 * verrait donc que les fournisseurs déjà consultés à la main.
 *
 * Ce job calcule chaque fournisseur une fois, séquentiellement — la persistance se fait
 * en effet de bord de `getProductRows()`. Séquentiel volontairement : le calcul est
 * lourd en SQL, le paralléliser saturerait PostgreSQL.
 */
type WarmupStatus = "idle" | "running" | "success" | "error";

interface WarmupJob {
    status: WarmupStatus;
    total: number;
    done: number;
    skipped: number;
    failed: number;
    currentFournisseur?: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    lastErrors: string[];
}

let job: WarmupJob | null = null;

function publicJob(j: WarmupJob | null) {
    if (!j) {
        return { status: "idle" as const, total: 0, done: 0, skipped: 0, failed: 0, lastErrors: [] };
    }
    return j;
}

async function requireAdmin(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if ((session.user as { role?: string } | undefined)?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
}

async function runWarmup(j: WarmupJob, staleHours: number): Promise<void> {
    try {
        const fournisseurs = await pgGetFournisseurs();
        // Les fournisseurs déjà calculés récemment sont sautés : un second passage
        // coûte alors quasiment rien, ce qui rend le bouton rejouable sans crainte.
        const existing = await listGridSuppliers();
        const freshLimit = Date.now() - staleHours * 3600_000;
        const fresh = new Set(
            existing
                .filter((s) => s.computedAt && new Date(s.computedAt).getTime() > freshLimit)
                .map((s) => s.codeFournisseur),
        );

        j.total = fournisseurs.length;
        console.log(`[grid-warmup] ${fournisseurs.length} fournisseurs, ${fresh.size} déjà à jour (< ${staleHours}h)`);

        for (const f of fournisseurs) {
            if (fresh.has(f.code)) {
                j.skipped++;
                continue;
            }
            j.currentFournisseur = `${f.code} — ${f.nom}`;
            try {
                await getProductRows({ codeFournisseur: f.code, magasin: "TOTAL", forceRefresh: true });
                j.done++;
            } catch (e) {
                j.failed++;
                const msg = `${f.code}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
                // On garde une trace des derniers échecs sans faire exploser la mémoire.
                if (j.lastErrors.length < 10) j.lastErrors.push(msg);
                console.error("[grid-warmup]", msg);
            }
        }

        j.currentFournisseur = undefined;
        j.status = "success";
        j.finishedAt = new Date().toISOString();
        console.log(`[grid-warmup] terminé — ${j.done} calculés, ${j.skipped} à jour, ${j.failed} en échec`);
    } catch (e) {
        j.status = "error";
        j.error = e instanceof Error ? e.message : String(e);
        j.finishedAt = new Date().toISOString();
        console.error("[grid-warmup] échec global:", j.error);
    }
}

/** GET /api/admin/grid-warmup — avancement du préchauffage. */
export async function GET() {
    const denied = await requireAdmin();
    if (denied) return denied;
    return NextResponse.json({ success: true, ...publicJob(job) });
}

/**
 * POST /api/admin/grid-warmup?staleHours=24
 * Démarre le préchauffage en arrière-plan et répond immédiatement.
 */
export async function POST(req: NextRequest) {
    const denied = await requireAdmin();
    if (denied) return denied;

    if (job?.status === "running") {
        return NextResponse.json({ success: true, ...publicJob(job) });
    }

    const raw = Number(req.nextUrl.searchParams.get("staleHours"));
    const staleHours = Number.isFinite(raw) ? Math.min(720, Math.max(0, raw)) : 24;

    job = {
        status: "running",
        total: 0,
        done: 0,
        skipped: 0,
        failed: 0,
        startedAt: new Date().toISOString(),
        lastErrors: [],
    };
    const current = job;
    console.log(`[grid-warmup] démarré (staleHours=${staleHours})`);

    void runWarmup(current, staleHours).catch((e) => {
        current.status = "error";
        current.error = e instanceof Error ? e.message : String(e);
        current.finishedAt = new Date().toISOString();
    });

    return NextResponse.json({ success: true, ...publicJob(job) });
}
