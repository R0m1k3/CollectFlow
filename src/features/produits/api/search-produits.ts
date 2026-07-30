import "server-only";

import { searchQlikArticles, QLIK_SEARCH_MAX_RESULTS } from "@/lib/qlik-search";
import { fetchNetworkMetricsPlaywright } from "@/lib/qlik-playwright";
import type { NetworkMetric } from "@/lib/qlik-client";
import { upsertNetworkMetrics } from "@/lib/qlik-network-cache";
import { buildGridNetworkQlikDateFilter, envMonthsBack, QLIK_MONTHS_BACK_DEFAULT } from "@/lib/qlik-date-range";
import { pgGetProduitsByCodeCentrale, pgSearchProduits, type PgProduitSearchRow } from "@/lib/pg-ff-client";
import { NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";
import { normalizeMargePct } from "@/features/produits/lib/compare-reseau";
import type { ProduitRechercheResultat, ProduitRechercheRow } from "@/features/produits/types";

/**
 * CollectFlow — Recherche produit **Qlik d'abord**, base FF Nancy ensuite.
 *
 * Déroulé :
 *   1. Qlik Sense : quels articles du réseau correspondent au terme ?
 *      (`searchQlikArticles` — libellé ou code centrale)
 *   2. Qlik Sense : métriques réseau 12 mois glissants de ces articles
 *      (`fetchNetworkMetricsPlaywright` — CA, qté, nb magasins, marge, mensuel)
 *   3. Base FF Nancy : lesquels référençons-nous ? (`pgGetProduitsByCodeCentrale`)
 *
 * Si Qlik est injoignable, on se rabat sur la recherche catalogue local pour ne
 * pas laisser l'utilisateur sans résultat — la réponse le signale explicitement
 * (`source: "db"`).
 */

/** Durée de validité d'un résultat de recherche en cache mémoire. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Durée de conservation d'un job terminé (le client a le temps de le relire). */
const JOB_TTL_MS = 5 * 60 * 1000;

/**
 * Nombre maximum de recherches Qlik simultanées.
 *
 * Le serveur Qlik sature vite (« Out of memory », « Request aborted ») : on
 * plafonne plutôt que de lui envoyer N extractions en parallèle.
 */
const MAX_RECHERCHES_SIMULTANEES = 2;

/**
 * Cache mémoire des recherches. Une recherche coûte deux allers-retours Qlik
 * (plusieurs secondes chacun) : sans ce cache, un retour arrière du navigateur
 * ou un rafraîchissement relancerait toute l'extraction.
 */
const cache = new Map<string, { at: number; result: ProduitRechercheResultat }>();

/**
 * Jobs de recherche, indexés par terme normalisé.
 *
 * Une recherche dure de quelques secondes à plusieurs minutes (deux allers-retours
 * Qlik dont une extraction mensuelle). Une requête HTTP maintenue aussi longtemps
 * se fait couper par le reverse proxy, qui répond une page d'erreur HTML — le
 * client recevait alors « Unexpected token '<' … is not valid JSON ». Le travail
 * tourne donc en tâche de fond et le client interroge l'état.
 */
const jobs = new Map<string, RechercheJob>();

export interface RechercheJob {
    jobId: string;
    terme: string;
    status: "running" | "success" | "error";
    /** Étape en cours, affichée pendant l'attente. */
    etape: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    result?: ProduitRechercheResultat;
}

/** État renvoyé au client : le job, ou `idle` si aucune recherche connue. */
export type RechercheEtat = RechercheJob | { status: "idle"; terme: string };

function cacheKey(term: string): string {
    return term.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Purge les entrées expirées (le volume reste faible, un balayage suffit). */
function purge(): void {
    const now = Date.now();
    for (const [k, v] of cache) {
        if (now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
    for (const [k, j] of jobs) {
        if (j.status !== "running" && j.finishedAt && now - Date.parse(j.finishedAt) > JOB_TTL_MS) jobs.delete(k);
    }
}

function jobsEnCours(): number {
    let n = 0;
    for (const j of jobs.values()) if (j.status === "running") n++;
    return n;
}

function jobTermine(terme: string, result: ProduitRechercheResultat): RechercheJob {
    return {
        jobId: `cache_${cacheKey(terme)}`,
        terme,
        status: "success",
        etape: "Terminé",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        result,
    };
}

/**
 * Démarre (ou réutilise) une recherche et rend la main **immédiatement**.
 *
 * - résultat déjà en cache et pas de `force` → job `success` directement ;
 * - recherche déjà en cours sur le même terme → on renvoie ce job ;
 * - sinon on lance le travail en tâche de fond.
 */
export function demarrerRecherche(
    term: string,
    options: { force?: boolean } = {},
): RechercheJob {
    const cleaned = term.trim();
    const key = cacheKey(cleaned);
    purge();

    if (!options.force) {
        const hit = cache.get(key);
        if (hit) {
            console.log(`[produits/search] "${cleaned}" — servi depuis le cache mémoire`);
            return jobTermine(cleaned, hit.result);
        }
    }

    const existant = jobs.get(key);
    if (existant && existant.status === "running") return existant;
    if (existant && !options.force && existant.status === "success" && existant.result) return existant;

    if (jobsEnCours() >= MAX_RECHERCHES_SIMULTANEES) {
        return {
            jobId: `refus_${Date.now().toString(36)}`,
            terme: cleaned,
            status: "error",
            etape: "Refusé",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: "Trop de recherches Qlik en cours. Réessayez dans quelques instants.",
        };
    }

    const job: RechercheJob = {
        jobId: `rech_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        terme: cleaned,
        status: "running",
        etape: "Recherche des articles dans Qlik…",
        startedAt: new Date().toISOString(),
    };
    jobs.set(key, job);
    console.log(`[produits/search] job=${job.jobId} démarré pour "${cleaned}"`);

    // Fire-and-forget : le client suivra l'avancement via `etatRecherche`.
    void executerRecherche(cleaned, (etape) => { job.etape = etape; })
        .then((result) => {
            job.result = result;
            job.status = "success";
            job.etape = "Terminé";
            job.finishedAt = new Date().toISOString();
            // On ne met en cache qu'un résultat Qlik exploitable : mémoriser un
            // repli catalogue (panne Qlik passagère) le figerait 10 minutes
            // alors qu'un simple « Relancer » aurait suffi.
            if (result.source === "qlik" && !result.qlikError) {
                cache.set(key, { at: Date.now(), result });
            }
            console.log(`[produits/search] job=${job.jobId} terminé — ${result.rows.length} produit(s) en ${result.dureeMs} ms`);
        })
        .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            job.status = "error";
            job.etape = "Échec";
            job.error = messageQlikLisible(message);
            job.finishedAt = new Date().toISOString();
            console.error(`[produits/search] job=${job.jobId} échec :`, message.slice(0, 300));
        });

    return job;
}

/** État courant de la recherche pour ce terme (pour le polling client). */
export function etatRecherche(term: string): RechercheEtat {
    const cleaned = term.trim();
    const key = cacheKey(cleaned);
    purge();
    const job = jobs.get(key);
    if (job) return job;
    const hit = cache.get(key);
    if (hit) return jobTermine(cleaned, hit.result);
    return { status: "idle", terme: cleaned };
}

async function executerRecherche(
    term: string,
    onEtape: (etape: string) => void = () => {},
): Promise<ProduitRechercheResultat> {
    const started = Date.now();

    // La recherche catalogue local tourne en parallèle : elle sert à la fois de
    // repli si Qlik échoue, et de complément (produits Nancy sans code centrale,
    // donc invisibles côté réseau).
    const localPromise = pgSearchProduits(term).catch((e) => {
        console.error("[produits/search] recherche locale échouée:", (e as Error).message);
        return [] as PgProduitSearchRow[];
    });

    let qlik;
    try {
        onEtape("Recherche des articles dans Qlik…");
        qlik = await searchQlikArticles(term, QLIK_SEARCH_MAX_RESULTS);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[produits/search] Qlik indisponible, repli catalogue local:", message);
        const locaux = await localPromise;
        return {
            rows: locaux.map(rowDepuisCatalogueSeul),
            source: "db",
            qlikError: messageQlikLisible(message),
            tronque: locaux.length >= 50,
            champUtilise: null,
            locauxHorsReseau: [],
            dureeMs: Date.now() - started,
        };
    }

    const codes = qlik.matches.map((m) => m.codeCentrale);
    if (codes.length === 0) {
        const locaux = await localPromise;
        return {
            rows: [],
            source: "qlik",
            // `avertissement` n'est renseigné que si Qlik a répondu sans appliquer
            // le filtre : l'utilisateur doit savoir que ce n'est pas « pas de
            // produit » mais « recherche non appliquée ».
            qlikError: qlik.avertissement,
            tronque: false,
            champUtilise: qlik.champUtilise,
            locauxHorsReseau: locaux,
            dureeMs: Date.now() - started,
        };
    }

    // Métriques réseau + détail mensuel sur la fenêtre 12 mois glissants (mois
    // courant exclu) — même extracteur que la sync fournisseur, donc mêmes
    // chiffres que la Grille.
    const monthsBack = envMonthsBack("QLIK_SYNC_MONTHS_BACK", QLIK_MONTHS_BACK_DEFAULT);
    const dateFilter = buildGridNetworkQlikDateFilter(new Date(), monthsBack);
    let metrics = new Map<string, NetworkMetric>();
    let metricsError: string | null = null;
    try {
        onEtape(`Extraction des ventes réseau de ${codes.length} article${codes.length > 1 ? "s" : ""} sur 12 mois…`);
        metrics = await fetchNetworkMetricsPlaywright(codes, undefined, dateFilter);
        // Le libellé / fournisseur ne sortent que de la recherche : on les
        // attache ici pour qu'ils soient persistés avec les mesures.
        for (const m of qlik.matches) {
            const metric = metrics.get(m.codeCentrale);
            if (!metric) continue;
            if (m.libelle) metric.libelleReseau = m.libelle;
            if (m.fournisseur) metric.fournisseurReseau = m.fournisseur;
        }
        // On alimente le cache `qlik_network_metrics` au passage : la fiche
        // produit ouverte depuis un résultat affichera les données réseau tout
        // de suite, sans re-extraction.
        if (metrics.size > 0) {
            const n = await upsertNetworkMetrics([...metrics.values()]);
            console.log(`[produits/search] ${n} ligne(s) réseau mises en cache`);
        }
    } catch (e) {
        // Les identités trouvées restent affichables sans les mesures : mieux
        // vaut une liste sans chiffres réseau qu'une page d'erreur.
        metricsError = e instanceof Error ? e.message : String(e);
        console.error("[produits/search] extraction des métriques réseau échouée:", metricsError);
    }

    onEtape("Rapprochement avec notre catalogue…");
    const catalogue = await pgGetProduitsByCodeCentrale(codes);
    const locaux = await localPromise;

    const rows: ProduitRechercheRow[] = qlik.matches.map((m) => {
        const net = metrics.get(m.codeCentrale);
        const local = catalogue.get(m.codeCentrale);
        const qteReseau = net?.qteReseau ?? 0;
        const caReseau = net?.caReseau ?? 0;
        const nbMag = net?.nbMagasinsReseau ?? 0;
        return {
            codeCentrale: m.codeCentrale,
            libelle: local?.libelle1 || m.libelle || m.codeCentrale,
            libelleReseau: m.libelle,
            fournisseur: local?.fournisseur || m.fournisseur || "",
            codein: local?.codein ?? null,
            nomenclature: local?.nomenclature ?? "",
            stockLocal: local ? Number(local.stock_total) || 0 : null,
            qteReseau,
            caReseau,
            nbMagasinsReseau: nbMag,
            tauxPresence: nbMag / NB_MAGASINS_RESEAU,
            qteParMagasinReseau: nbMag > 0 ? qteReseau / nbMag : 0,
            caParMagasinReseau: net?.caParMagasinReseau ?? 0,
            prixMoyenReseau: qteReseau > 0 ? caReseau / qteReseau : null,
            margePctReseau: normalizeMargePct(net?.margePctReseau),
            qteByMonth: net?.qteByMonth ?? null,
            periode: net?.periode ?? dateFilter.label,
        };
    });

    // Les plus vendus du réseau d'abord : c'est l'information utile pour
    // arbitrer, un produit que le réseau ne vend pas n'intéresse personne.
    rows.sort((a, b) => b.qteReseau - a.qteReseau || a.libelle.localeCompare(b.libelle, "fr"));

    const codesTrouves = new Set(codes);
    const locauxHorsReseau = locaux.filter((l) => !l.code_centrale || !codesTrouves.has(l.code_centrale));

    return {
        rows,
        source: "qlik",
        qlikError: metricsError ? messageQlikLisible(metricsError) : null,
        tronque: qlik.tronque,
        champUtilise: qlik.champUtilise,
        locauxHorsReseau,
        dureeMs: Date.now() - started,
    };
}

/** Ligne de repli : catalogue Nancy seul, sans données réseau fiables. */
function rowDepuisCatalogueSeul(r: PgProduitSearchRow): ProduitRechercheRow {
    const qteReseau = Number(r.qte_reseau) || 0;
    const nbMag = Number(r.nb_magasins_reseau) || 0;
    return {
        codeCentrale: r.code_centrale,
        libelle: r.libelle1 || r.codein,
        libelleReseau: "",
        fournisseur: r.fournisseur,
        codein: r.codein,
        nomenclature: r.nomenclature,
        stockLocal: Number(r.stock_total) || 0,
        qteReseau,
        caReseau: 0,
        nbMagasinsReseau: nbMag,
        tauxPresence: nbMag / NB_MAGASINS_RESEAU,
        qteParMagasinReseau: nbMag > 0 ? qteReseau / nbMag : 0,
        caParMagasinReseau: 0,
        prixMoyenReseau: null,
        margePctReseau: null,
        qteByMonth: null,
        periode: null,
    };
}

/**
 * Traduit les pannes Qlik récurrentes en message actionnable. Les autres
 * erreurs sont renvoyées telles quelles (tronquées) pour rester diagnosticables.
 */
function messageQlikLisible(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("out of memory") || lower.includes("not enough memory") || lower.includes('"code":6') || lower.includes('"code":3002')) {
        return "Serveur Qlik saturé : mémoire insuffisante pour charger l'application. Réessayez plus tard.";
    }
    if (/"code"\s*:\s*15\b/.test(message) || lower.includes("request aborted")) {
        return "Qlik a interrompu la requête (recherche trop large pour le moteur). Ajoutez un mot plus précis, puis relancez.";
    }
    if (lower.includes("identifiants qlik manquants") || lower.includes("qlik_user")) {
        return "Identifiants Qlik non configurés (Paramètres → Qlik).";
    }
    if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("enotfound")) {
        return "Serveur Qlik injoignable depuis CollectFlow (réseau ou VPN).";
    }
    return message.slice(0, 300);
}
