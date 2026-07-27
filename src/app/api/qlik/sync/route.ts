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
    /** Code fournisseur (mode fournisseur) — chaîne vide en mode produit. */
    fournisseur: string;
    /** Code centrale (mode produit) — absent en mode fournisseur. */
    codeCentrale?: string;
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

/**
 * Clé de job. Le mode fournisseur garde sa clé historique (le code fournisseur
 * brut) ; le mode produit est préfixé pour ne jamais entrer en collision.
 */
function jobKeyForProduct(codeCentrale: string): string {
    return `cc:${codeCentrale.toUpperCase()}`;
}

/**
 * Nombre maximum d'extractions produit simultanées.
 *
 * Le mode produit est ouvert à tous les utilisateurs connectés (contrairement au
 * mode fournisseur, réservé aux admins). Une extraction sur 1 seul code est très
 * légère, mais le serveur Qlik est sujet aux saturations mémoire : on plafonne
 * la concurrence plutôt que de lui laisser prendre N requêtes en parallèle.
 */
const MAX_CONCURRENT_PRODUCT_JOBS = 3;

/** Compte les extractions produit actuellement en cours. */
function runningProductJobs(): number {
    let n = 0;
    for (const [key, job] of jobs) {
        if (key.startsWith("cc:") && job.status === "running") n++;
    }
    return n;
}

/** Construit un jobId court et lisible. */
function newJobId(): string {
    return `qlik_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Sérialise un job pour la réponse HTTP. */
function publicJob(job: QlikSyncJob) {
    return {
        jobId: job.jobId,
        fournisseur: job.fournisseur,
        codeCentrale: job.codeCentrale,
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

/** État "idle" sérialisé (pas de job connu pour cette cible). */
function idleJob(fournisseur: string, codeCentrale?: string) {
    return {
        jobId: null,
        fournisseur,
        codeCentrale,
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
 * Vérifie qu'une session existe (sans exiger le rôle admin).
 *
 * Utilisé par le mode produit : le middleware Next ne couvre PAS les routes
 * `/api/*`, le contrôle doit donc être fait ici explicitement.
 */
async function requireSession(): Promise<NextResponse | null> {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
        applyJobError(job, e);
    }
}

/**
 * Inscrit une erreur dans le job, en traduisant la saturation mémoire du
 * serveur Qlik en message actionnable (ce n'est PAS un bug CollectFlow :
 * l'app Qlik ne se charge même pas).
 */
function applyJobError(job: QlikSyncJob, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[api/qlik/sync] job=${job.jobId}`, msg);
    job.status = "error";
    const lower = msg.toLowerCase();
    if (lower.includes("out of memory") || lower.includes("not enough memory") || lower.includes("file corrupted") || lower.includes('"code":6') || lower.includes('"code":3002')) {
        job.error = "Serveur Qlik saturé : mémoire insuffisante pour charger l'application. Réessayez plus tard (ou faites libérer / augmenter la RAM du serveur Qlik).";
    } else {
        job.error = msg;
    }
    job.finishedAt = new Date().toISOString();
}

/**
 * Extraction Qlik pour UN seul code centrale (fiche produit).
 *
 * Beaucoup plus légère que la sync fournisseur : un seul code au lieu de
 * plusieurs centaines, sur la même fenêtre 12 mois glissants. Réutilise
 * exactement le même extracteur, donc le même détail mensuel.
 */
async function runProductJob(job: QlikSyncJob): Promise<void> {
    try {
        const code = job.codeCentrale!;
        job.requested = 1;

        const monthsBack = envMonthsBack("QLIK_SYNC_MONTHS_BACK", QLIK_MONTHS_BACK_DEFAULT);
        const dateFilter = buildGridNetworkQlikDateFilter(new Date(), monthsBack);
        job.periode = dateFilter.label;
        job.dateDebut = dateFilter.dateDebut;
        job.dateFin = dateFilter.dateFin;
        console.log(
            `[api/qlik/sync] job=${job.jobId} → extraction Qlik produit (1 code) — fenêtre ${dateFilter.label} (${dateFilter.dateDebut} → ${dateFilter.dateFin})…`,
        );

        const metrics = await fetchNetworkMetricsPlaywright([code], undefined, dateFilter);
        job.fetched = metrics.size;
        if (metrics.size === 0) {
            job.status = "success";
            job.message = "Ce code centrale est inconnu de Qlik (aucune vente réseau sur la période)";
            job.finishedAt = new Date().toISOString();
            return;
        }
        const count = await upsertNetworkMetrics([...metrics.values()]);
        job.upserted = count;
        job.status = "success";
        job.message = "Données réseau récupérées";
        job.finishedAt = new Date().toISOString();
        console.log(`[api/qlik/sync] job=${job.jobId} produit ${code} — ${count} ligne(s) upsert`);
    } catch (e) {
        applyJobError(job, e);
    }
}

/**
 * GET /api/qlik/sync?fournisseur=XXX  ou  ?codeCentrale=YYY
 * Retourne l'état courant du job pour cette cible. Si aucun job n'est
 * connu, renvoie un état "idle" (avec un message explicite). Permet au
 * frontend de reprendre l'état après un reload et de poller en arrière-plan.
 */
export async function GET(req: NextRequest) {
    const codeCentrale = req.nextUrl.searchParams.get("codeCentrale");
    const fournisseur = req.nextUrl.searchParams.get("fournisseur");

    // Mode produit : ouvert à tout utilisateur connecté.
    if (codeCentrale) {
        const denied = await requireSession();
        if (denied) return denied;
        const job = jobs.get(jobKeyForProduct(codeCentrale));
        if (!job) {
            return NextResponse.json({ success: true, ...idleJob("", codeCentrale) });
        }
        return NextResponse.json({ success: true, ...publicJob(job) });
    }

    // Mode fournisseur : admin uniquement (inchangé).
    const denied = await requireAdmin();
    if (denied) return denied;

    if (!fournisseur) {
        return NextResponse.json({ error: "Param 'fournisseur' ou 'codeCentrale' requis" }, { status: 400 });
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
    const codeCentraleParam = req.nextUrl.searchParams.get("codeCentrale");

    // ─── Mode produit : 1 code centrale, ouvert à tout utilisateur connecté ───
    if (codeCentraleParam) {
        const denied = await requireSession();
        if (denied) return denied;

        // Même validation que la sync fournisseur (trim, rejet des vides / "-" /
        // codes hors charset) pour ne jamais envoyer de saleté à l'Engine Qlik.
        const { accepted } = filterCentralCodes([codeCentraleParam]);
        if (accepted.length === 0) {
            return NextResponse.json({ error: "Code centrale invalide" }, { status: 400 });
        }
        const code = accepted[0];
        const key = jobKeyForProduct(code);

        const existingProduct = jobs.get(key);
        if (existingProduct && existingProduct.status === "running") {
            return NextResponse.json({ success: true, ...publicJob(existingProduct) });
        }

        if (runningProductJobs() >= MAX_CONCURRENT_PRODUCT_JOBS) {
            return NextResponse.json(
                { error: "Trop d'extractions Qlik en cours. Réessayez dans quelques instants." },
                { status: 429 },
            );
        }

        const productJob: QlikSyncJob = {
            jobId: newJobId(),
            fournisseur: "",
            codeCentrale: code,
            status: "running",
            requested: 0,
            fetched: 0,
            upserted: 0,
            startedAt: new Date().toISOString(),
        };
        jobs.set(key, productJob);
        console.log(`[api/qlik/sync] job=${productJob.jobId} démarré pour codeCentrale=${code}`);

        void runProductJob(productJob).catch((e) => applyJobError(productJob, e));

        return NextResponse.json({ success: true, ...publicJob(productJob) });
    }

    // ─── Mode fournisseur : admin uniquement (inchangé) ──────────────────────
    const denied = await requireAdmin();
    if (denied) return denied;

    const fournisseur = req.nextUrl.searchParams.get("fournisseur");
    if (!fournisseur) {
        return NextResponse.json({ error: "Param 'fournisseur' ou 'codeCentrale' requis" }, { status: 400 });
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
