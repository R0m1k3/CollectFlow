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

/**
 * Cache mémoire des recherches. Une recherche coûte deux allers-retours Qlik
 * (plusieurs secondes chacun) : sans ce cache, un retour arrière du navigateur
 * ou un rafraîchissement relancerait toute l'extraction.
 */
const cache = new Map<string, { at: number; result: ProduitRechercheResultat }>();

/** Recherches en cours, pour ne pas lancer deux extractions identiques en parallèle. */
const enCours = new Map<string, Promise<ProduitRechercheResultat>>();

function cacheKey(term: string): string {
    return term.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Purge les entrées expirées (le volume reste faible, un balayage suffit). */
function purgeCache(): void {
    const now = Date.now();
    for (const [k, v] of cache) {
        if (now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
}

export async function rechercherProduits(
    term: string,
    options: { force?: boolean } = {},
): Promise<ProduitRechercheResultat> {
    const cleaned = term.trim();
    if (cleaned.length < 3) {
        return {
            rows: [], source: "qlik", qlikError: null, tronque: false,
            champUtilise: null, locauxHorsReseau: [], dureeMs: 0,
        };
    }

    const key = cacheKey(cleaned);
    purgeCache();
    if (!options.force) {
        const hit = cache.get(key);
        if (hit) {
            console.log(`[produits/search] "${cleaned}" — servi depuis le cache mémoire`);
            return hit.result;
        }
        const running = enCours.get(key);
        if (running) return running;
    }

    const p = executerRecherche(cleaned).finally(() => enCours.delete(key));
    enCours.set(key, p);
    const result = await p;
    cache.set(key, { at: Date.now(), result });
    return result;
}

async function executerRecherche(term: string): Promise<ProduitRechercheResultat> {
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
            qlikError: null,
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
    if (lower.includes("identifiants qlik manquants") || lower.includes("qlik_user")) {
        return "Identifiants Qlik non configurés (Paramètres → Qlik).";
    }
    if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("enotfound")) {
        return "Serveur Qlik injoignable depuis CollectFlow (réseau ou VPN).";
    }
    return message.slice(0, 300);
}
