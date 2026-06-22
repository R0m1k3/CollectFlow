import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchNetworkMetricsPlaywright } from "@/lib/qlik-playwright";
import { upsertNetworkMetrics } from "@/lib/qlik-network-cache";
import { pgGetArticlesByFournisseur } from "@/lib/pg-ff-client";
import {
    buildGridNetworkQlikDateFilter,
    envMonthsBack,
    QLIK_MONTHS_BACK_DEFAULT,
    QLIK_MONTHS_BACK_MAX,
    QLIK_MONTHS_BACK_MIN,
} from "@/lib/qlik-date-range";

// Tâche d'extraction Qlik potentiellement très longue (hypercube paginé).
// On accepte quand même 5 min côté plateforme Next.js, mais on rend la main au
// client tout de suite via le state job ci-dessous.
export const maxDuration = 300;
// Forcer le runtime Node.js : Playwright/Chromium ne tourne pas en edge et on a
// besoin d'un process persistant pour conserver l'état de job en mémoire.
export const runtime = "nodejs";
// Toujours exécuter dynamiquement (sinon Next peut essayer de cacher des POST).
export const dynamic = "force-dynamic";

/** État d'un job de sync Qlik pour un fournisseur donné. */
type QlikSyncStatus = "idle" | "running" | "success" | "error";

interface QlikSyncJob {
    jobId: string;
    fournisseur: string;
    status: QlikSyncStatus;
    requested: number;
    fetched: number;
    upserted: number;
    periode?: string;
    dateDebut?: string;
    dateFin?: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    message?: string;
}

/**
 * Store en mémoire au niveau module. Une Map par fournisseur car on ne lance
 * qu'une extraction à la fois par fournisseur. C'est volontairement simple :
 * si le process redémarre, les jobs en cours sont perdus → GET renverra idle
 * et l'utilisateur pourra relancer. Suffisant pour corriger le bug UX.
 */
const jobs = new Map<string, QlikSyncJob>();

/** Construit un jobId court et lisible. */
function newJobId(): string {
    return `qlik_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Sérialise un job pour la réponse HTTP. */
function publicJob(job: QlikSyncJob) {
    return {
        jobId: job.jobId,
        fournisseur: job.fournisseur,
        status: job.status,
        requested: job.requested,
        fetched: job.fetched,
        upserted: job.upserted,
        periode: job.periode,
        dateDebut: job.dateDebut,
        dateFin: job.dateFin,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error,
        message: job.message,
    };
}

/** État "idle" sérialisé (pas de job connu pour ce fournisseur). */
function idleJob(fournisseur: string) {
    return {
        jobId: null,
        fournisseur,
        status: "idle" as const,
        requested: 0,
        fetched: 0,
        upserted: 0,
        periode: undefined,
        dateDebut: undefined,
        dateFin: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
        message: undefined,
    };
}

/**
 * Vérifie l'auth admin. Renvoie une réponse 403/401 si refusée, sinon null.
 */
async function requireAdmin(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if ((session.user as { role?: string } | undefined)?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
}

/**
 * Regex de validation d'un code centrale "raisonnable".
 *
 * Format attendu d'après l'API FF : préfixe `10000` + 6 chiffres (ex `10000167303`),
 * donc 11 caractères alphanumériques. Pour rester large et ne pas casser
 * d'éventuels codes alphanumériques fournisseur (refs internes), on autorise
 *   - longueur 2..30
 *   - jeu `[A-Z0-9_-]`
 *   - premier caractère alphanumérique (pas `_` ni `-`)
 *
 * But : éviter d'envoyer à Qlik des chaînes vides, des `-`, des espaces
 * parasites, ou des entrées manifestement invalides qui déclenchent des
 * codes d'erreur Engine ou du gaspillage réseau. **Volontairement simple** :
 * on ne touche pas au mapping ; on filtre seulement ce qui ne ressemble à
 * aucun code plausible.
 */
const CENTRAL_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,29}$/i;

/**
 * Filtre strict des codes centraux avant d'envoyer à Qlik.
 * - trim + drop vides
 * - drop "-" (placeholder déjà exclu côté agrégation mais on double-check)
 * - drop doublons (préserve l'ordre, comparaison insensible à la casse)
 * - drop codes ne matchant pas CENTRAL_CODE_REGEX (longueur / charset)
 *
 * Renvoie `{ accepted, rejected, deduped }`. Les logs n'exposent que les
 * compteurs, jamais les valeurs des codes.
 */
function filterCentralCodes(rawCodes: Array<string | null | undefined>): {
    accepted: string[];
    rejected: number;
    deduped: number;
} {
    const seen = new Set<string>();
    const accepted: string[] = [];
    let rejected = 0;
    let deduped = 0;
    for (const raw of rawCodes) {
        if (raw == null) {
            rejected++;
            continue;
        }
        const code = String(raw).trim();
        const key = code.toUpperCase();
        if (!code || code === "-" || code === "_") {
            rejected++;
            continue;
        }
        if (seen.has(key)) {
            deduped++;
            continue;
        }
        if (!CENTRAL_CODE_REGEX.test(code)) {
            rejected++;
            continue;
        }
        seen.add(key);
        accepted.push(code);
    }
    return { accepted, rejected, deduped };
}

/**
 * Exécute réellement l'extraction + l'upsert, en mettant à jour le job
 * au fur et à mesure (compteur fetched, puis upserted, puis finishedAt).
 */
async function runJob(job: QlikSyncJob): Promise<void> {
    try {
        const articles = await pgGetArticlesByFournisseur(job.fournisseur);
        // Filtre strict des codes (trim, dedupe, exclusion vides/`-`/codes trop suspects).
        const { accepted: codes, rejected: codesRejected, deduped: codesDeduped } = filterCentralCodes(
            articles.map((a) => a.codeCentrale),
        );
        job.requested = codes.length;
        console.log(
            `[api/qlik/sync] job=${job.jobId} fournisseur=${job.fournisseur} — ${articles.length} articles, ${codes.length} codes centraux retenus, ${codesRejected} rejetés (vide/-/anormaux), ${codesDeduped} doublons supprimés`,
        );
        if (codes.length === 0) {
            job.status = "success";
            job.message = "Aucun code centrale valide pour ce fournisseur";
            job.finishedAt = new Date().toISOString();
            return;
        }

        // Fenêtre temporelle alignée sur la grille, éventuellement raccourcie via
        // QLIK_SYNC_MONTHS_BACK (1..12, défaut 12). On logue la valeur effective
        // pour audit.
        const monthsBack = envMonthsBack("QLIK_SYNC_MONTHS_BACK", QLIK_MONTHS_BACK_DEFAULT);
        const dateFilter = buildGridNetworkQlikDateFilter(new Date(), monthsBack);
        job.periode = dateFilter.label;
        job.dateDebut = dateFilter.dateDebut;
        job.dateFin = dateFilter.dateFin;
        console.log(
            `[api/qlik/sync] job=${job.jobId} → extraction Qlik pour ${codes.length} codes — fenêtre ${dateFilter.label} (${dateFilter.dateDebut} → ${dateFilter.dateFin}, QLIK_SYNC_MONTHS_BACK=${monthsBack}, bornes ${QLIK_MONTHS_BACK_MIN}..${QLIK_MONTHS_BACK_MAX})…`,
        );
        const metrics = await fetchNetworkMetricsPlaywright(codes, undefined, dateFilter);
        job.fetched = metrics.size;
        console.log(`[api/qlik/sync] job=${job.jobId} ← Qlik a renvoyé ${metrics.size} produits réseau`);
        const count = await upsertNetworkMetrics([...metrics.values()]);
        job.upserted = count;
        console.log(`[api/qlik/sync] job=${job.jobId} ${count} lignes upsert dans le cache`);
        job.status = "success";
        job.finishedAt = new Date().toISOString();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[api/qlik/sync] job=${job.jobId}`, msg);
        job.status = "error";
        job.error = msg;
        job.finishedAt = new Date().toISOString();
    }
}

/**
 * GET /api/qlik/sync?fournisseur=XXX
 * Retourne l'état courant du job pour ce fournisseur. Si aucun job n'est
 * connu, renvoie un état "idle" (avec un message explicite). Permet au
 * frontend de reprendre l'état après un reload et de poller en arrière-plan.
 */
export async function GET(req: NextRequest) {
    const denied = await requireAdmin();
    if (denied) return denied;

    const fournisseur = req.nextUrl.searchParams.get("fournisseur");
    if (!fournisseur) {
        return NextResponse.json({ error: "Param 'fournisseur' requis" }, { status: 400 });
    }
    const job = jobs.get(fournisseur);
    if (!job) {
        return NextResponse.json({ success: true, ...idleJob(fournisseur) });
    }
    return NextResponse.json({ success: true, ...publicJob(job) });
}

/**
 * POST /api/qlik/sync?fournisseur=XXX
 * Démarre (ou réutilise si déjà running) un job d'extraction en arrière-plan
 * et retourne *immédiatement* { success, status, jobId, ... }. Le client doit
 * ensuite poller GET pour suivre l'avancement et être notifié de la fin.
 */
export async function POST(req: NextRequest) {
    const denied = await requireAdmin();
    if (denied) return denied;

    const fournisseur = req.nextUrl.searchParams.get("fournisseur");
    if (!fournisseur) {
        return NextResponse.json({ error: "Param 'fournisseur' requis" }, { status: 400 });
    }

    const existing = jobs.get(fournisseur);
    if (existing && existing.status === "running") {
        // Un job tourne déjà pour ce fournisseur : on le réutilise.
        return NextResponse.json({ success: true, ...publicJob(existing) });
    }

    const job: QlikSyncJob = {
        jobId: newJobId(),
        fournisseur,
        status: "running",
        requested: 0,
        fetched: 0,
        upserted: 0,
        startedAt: new Date().toISOString(),
    };
    jobs.set(fournisseur, job);
    console.log(`[api/qlik/sync] job=${job.jobId} démarré pour fournisseur=${fournisseur}`);

    // Lancement fire-and-forget. On ne `await` PAS l'extraction ici : on
    // renvoie tout de suite au client et il polle GET. Les erreurs sont
    // capturées dans runJob et inscrites dans le job.
    void runJob(job).catch((e) => {
        // Filet de sécurité (runJob ne devrait pas throw, mais on ne veut
        // jamais qu'une exception non capturée crashe le process).
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[api/qlik/sync] job=${job.jobId} crash non géré`, msg);
        job.status = "error";
        job.error = msg;
        job.finishedAt = new Date().toISOString();
    });

    return NextResponse.json({ success: true, ...publicJob(job) });
}
