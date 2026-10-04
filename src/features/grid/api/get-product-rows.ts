import "server-only";

import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { buildLast12MonthsRange, getMensuelByArticles } from "@/lib/api-ff-client";
import {
    pgGetArticlesByFournisseur,
    pgGetMensuelByFournisseur,
    pgGetGammesByFournisseur,
    pgGetNomenclatureByFournisseur,
    pgGetStockByFournisseur,
    pgGetCommandesByFournisseur,
    pgGetPrixVenteByFournisseur,
    type PgStockRow,
} from "@/lib/pg-ff-client";
import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getNetworkMetricsByCodeCentrale, type NetworkMetricCached } from "@/lib/qlik-network-cache";
import { NB_MAGASINS_RESEAU } from "@/features/grid/lib/network-trend";
// Persiste l'instantané lu par /api/v1 : sans lui, l'API n'aurait aucune donnée.
import { readGridSnapshot, upsertGridRows } from "@/lib/grid-store";
import {
    applyStorePatchInPlace,
    buildStorePatchEntries,
    storePatchCandidates,
    type StorePatch,
    type StorePatchEntry,
} from "@/features/grid/lib/store-patch";

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
    forceRefresh?: boolean;
}

const GRID_ROWS_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Bornes du cache mémoire. La synchro nocturne et le préchauffage passent par
 * `getProductRows()` pour CHAQUE fournisseur : sans plafond, le processus finissait
 * par garder toutes les grilles en mémoire (plusieurs centaines de Mo), ce qui
 * ralentissait toutes les requêtes (ramasse-miettes). Ordre d'insertion de la Map
 * = ordre d'usage : on évince les entrées les moins récemment servies.
 */
const GRID_ROWS_CACHE_MAX_ENTRIES = Number(process.env.GRID_ROWS_CACHE_MAX_ENTRIES ?? 30);
const GRID_ROWS_CACHE_MAX_ROWS = Number(process.env.GRID_ROWS_CACHE_MAX_ROWS ?? 150_000);
const gridRowsCache = new Map<string, { rows: ProductRow[]; createdAt: number }>();
const gridRowsPending = new Map<string, Promise<ProductRow[]>>();
/** Nombre d'enregistrements de gammes par fournisseur (cf. patchGridRowsCache). */
const gammeSaveVersion = new Map<string, number>();

function cacheGridRows(key: string, rows: ProductRow[]): void {
    gridRowsCache.delete(key);
    gridRowsCache.set(key, { rows, createdAt: Date.now() });
    let totalRows = 0;
    for (const entry of gridRowsCache.values()) totalRows += entry.rows.length;
    for (const [oldKey, entry] of gridRowsCache) {
        if (gridRowsCache.size <= 1) break;
        if (gridRowsCache.size <= GRID_ROWS_CACHE_MAX_ENTRIES && totalRows <= GRID_ROWS_CACHE_MAX_ROWS) break;
        gridRowsCache.delete(oldKey);
        totalRows -= entry.rows.length;
    }
}

function gridRowsCacheKey(input: GetProductRowsInput): string {
    return `${input.codeFournisseur}:${input.magasin ?? "TOTAL"}`;
}

export function invalidateGridRowsCache(codeFournisseur?: string) {
    if (codeFournisseur) {
        for (const key of gridRowsCache.keys()) {
            if (key.startsWith(`${codeFournisseur}:`)) gridRowsCache.delete(key);
        }
        for (const key of gridRowsPending.keys()) {
            if (key.startsWith(`${codeFournisseur}:`)) gridRowsPending.delete(key);
        }
        return;
    }
    gridRowsCache.clear();
    gridRowsPending.clear();
}

/**
 * Reporte des gammes enregistrées sur les lignes déjà en cache, au lieu de jeter
 * le cache : l'invalidation forçait un recalcul complet (jusqu'à ~40 s sur un gros
 * fournisseur) à la réouverture suivante. Le résultat est celui qu'aurait donné
 * ce recalcul : la colonne Gamme reprend la valeur du dernier snapshot (Phase 9),
 * la colonne INIT reste l'état serveur.
 */
export function patchGridRowsCache(
    codeFournisseur: string,
    changes: ReadonlyArray<{ codein: string; codeGamme: string }>,
): void {
    if (changes.length === 0) return;
    // Un calcul en cours pour ce fournisseur a lu les gammes avant cet
    // enregistrement : le compteur lui signale de les relire avant d'être caché.
    gammeSaveVersion.set(codeFournisseur, (gammeSaveVersion.get(codeFournisseur) ?? 0) + 1);
    const byCodein = new Map(changes.map((c) => [c.codein, c.codeGamme as GammeCode]));
    for (const [key, entry] of gridRowsCache) {
        if (!key.startsWith(`${codeFournisseur}:`)) continue;
        for (const row of entry.rows) {
            const gamme = byCodein.get(row.codein);
            if (gamme !== undefined) row.codeGamme = gamme;
        }
    }
}

/**
 * Rafraîchit UNIQUEMENT la colonne INIT (codeGammeInit = gamme serveur courante)
 * sur des lignes servies depuis le cache. La colonne Gamme (codeGamme) n'est pas
 * touchée : elle conserve la valeur issue du snapshot. Ainsi l'état serveur (INIT)
 * est toujours à jour à chaque chargement, même sur un hit du cache 10 min — et le
 * marqueur "modifié" (Gamme ≠ INIT) se résorbe dès que le serveur rattrape la modif.
 */
async function refreshGammeInit(rows: ProductRow[], codeFournisseur: string): Promise<void> {
    try {
        const gammeMap = await pgGetGammesByFournisseur(codeFournisseur);
        if (gammeMap.size === 0) return;
        for (const row of rows) {
            const live = gammeMap.get(row.codein);
            if (live !== undefined) row.codeGammeInit = live as GammeCode;
        }
    } catch (e) {
        console.error("[getProductRows] refreshGammeInit error:", (e as Error).message?.slice(0, 200));
    }
}

/**
 * Écrit l'instantané de grille lu par /api/v1 (table `grid_rows`).
 *
 * Seul `magasin = TOTAL` est persisté : `ProductRow` embarque déjà les ventilations
 * par magasin (sales12mByStore, caByStore…), inutile de stocker trois variantes.
 * Toute erreur est avalée : la persistance ne doit jamais casser l'affichage.
 */
async function persistGridSnapshot(input: GetProductRowsInput, rows: ProductRow[]): Promise<void> {
    if ((input.magasin ?? "TOTAL") !== "TOTAL") return;
    try {
        const n = await upsertGridRows(input.codeFournisseur, rows);
        console.log(`[getProductRows] instantané persisté: ${n} lignes pour ${input.codeFournisseur}`);
    } catch (e) {
        console.error("[getProductRows] persistance grid_rows KO:", (e as Error).message?.slice(0, 200));
    }
}

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const cacheKey = gridRowsCacheKey(input);
    const cached = gridRowsCache.get(cacheKey);
    if (!input.forceRefresh && cached && Date.now() - cached.createdAt < GRID_ROWS_CACHE_TTL_MS) {
        // Remonte l'entrée en tête de l'ordre d'usage (éviction LRU).
        gridRowsCache.delete(cacheKey);
        gridRowsCache.set(cacheKey, cached);
        // La colonne INIT doit refléter l'état serveur à CHAQUE chargement,
        // y compris sur un hit de cache (les données lourdes restent, elles, cachées).
        await refreshGammeInit(cached.rows, input.codeFournisseur);
        return cached.rows;
    }

    // Un calcul déjà en cours est réutilisé même en rechargement forcé : il part
    // de données fraîches, et en lancer un second en parallèle doublait la charge
    // (double clic, onglet rouvert…) sans rien apporter.
    const pending = gridRowsPending.get(cacheKey);
    if (pending) {
        return pending;
    }

    // Instantané persisté (calcul de la nuit ou de la dernière ouverture) : servi
    // en une lecture au lieu d'un recalcul de 10 à 40 s. Jamais en rechargement
    // forcé — c'est précisément ce que l'utilisateur demande d'éviter.
    if (!input.forceRefresh) {
        const servi = await serveFromSnapshot(input, cacheKey);
        if (servi) return servi;
    }

    const versionAuDepart = gammeSaveVersion.get(input.codeFournisseur) ?? 0;
    const promise = buildProductRows(input).then(async (rows) => {
        if ((gammeSaveVersion.get(input.codeFournisseur) ?? 0) !== versionAuDepart) {
            // Gammes enregistrées pendant le calcul : on reprend le dernier snapshot.
            applySnapshotChanges(rows, await loadLatestSnapshotChanges(input.codeFournisseur));
        }
        cacheGridRows(cacheKey, rows);
        gridRowsPending.delete(cacheKey);
        // Persiste l'instantané pour /api/v1 : le calcul vient d'avoir lieu, on
        // arrête simplement de jeter le résultat. Volontairement NON bloquant —
        // l'affichage de la Grille ne doit pas attendre l'écriture.
        void persistGridSnapshot(input, rows);
        return rows;
    }).catch((error) => {
        gridRowsPending.delete(cacheKey);
        throw error;
    });

    gridRowsPending.set(cacheKey, promise);
    return promise;
}

/** Au-delà, l'instantané est servi mais un recalcul est relancé en arrière-plan. */
const SNAPSHOT_REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;

/**
 * Sert la Grille depuis `grid_rows` quand c'est possible : mêmes lignes que le
 * calcul en direct (elles en sont issues), avec la gamme FF du moment (INIT) et
 * les dernières gammes enregistrées reportées dessus. Hors « tous magasins »,
 * le rattrapage du magasin choisi est appliqué comme après un calcul.
 *
 * `null` = pas d'instantané utilisable (absent, ancien format, autre mois) :
 * l'appelant recalcule.
 */
async function serveFromSnapshot(input: GetProductRowsInput, cacheKey: string): Promise<ProductRow[] | null> {
    const { codeFournisseur, magasin = "TOTAL" } = input;
    let snapshot: Awaited<ReturnType<typeof readGridSnapshot>>;
    try {
        snapshot = await readGridSnapshot(codeFournisseur);
    } catch (e) {
        console.error("[getProductRows] lecture grid_rows KO:", (e as Error).message?.slice(0, 200));
        return null;
    }
    if (!snapshot || snapshot.rows.length === 0) return null;

    const { rows } = snapshot;
    const [changes] = await Promise.all([
        loadLatestSnapshotChanges(codeFournisseur),
        refreshGammeInit(rows, codeFournisseur),
    ]);
    applySnapshotChanges(rows, changes);

    if (magasin !== "TOTAL") {
        const { dateDebut, dateFin } = buildLast12MonthsRange();
        await reconcileSelectedStoreFromMensuelApi(rows, magasin, dateDebut, dateFin, last12Periods());
    }

    cacheGridRows(cacheKey, rows);

    // Instantané qui n'a pas été recalculé par la nuit : on le rafraîchit sans
    // faire attendre l'utilisateur (la prochaine ouverture en profitera).
    // Toujours le calcul « tous magasins » : c'est lui qui réécrit l'instantané.
    if (Date.now() - snapshot.computedAt.getTime() > SNAPSHOT_REFRESH_AFTER_MS && !gridRowsPending.has(`${codeFournisseur}:TOTAL`)) {
        void getProductRows({ codeFournisseur, magasin: "TOTAL", forceRefresh: true }).catch((e) =>
            console.error("[getProductRows] rafraîchissement en arrière-plan KO:", (e as Error).message?.slice(0, 200)),
        );
    }
    return rows;
}

/** Les 12 derniers mois complets, clés « YYYYMM » triées (même fenêtre que le calcul). */
function last12Periods(): string[] {
    const now = new Date();
    const periods: string[] = [];
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        periods.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return periods;
}

async function buildProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL" } = input;
    console.log(`\n>>> [getProductRows] supplier: ${codeFournisseur}, magasin: ${magasin}`);

    try {
        const { dateDebut, dateFin } = buildLast12MonthsRange();

        // ─── Phase 1 : 7 requêtes SQL en parallèle ────────────────────────────
        // Remplace des centaines/milliers d'appels HTTP per-article.
        const articlesPromise = pgGetArticlesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetArticlesByFournisseur ERROR:", e); return []; });
        // Phases 8 et 9 lancées dès maintenant : elles n'attendent que la liste des
        // articles (codes centraux) ou le seul code fournisseur. Exécutées après la
        // Phase 1, elles ajoutaient deux allers-retours en série à chaque calcul.
        const networkPromise = articlesPromise.then((arts) =>
            fetchNetworkMetrics(arts.map((a) => (a.codeCentrale ? String(a.codeCentrale).trim() : ""))),
        );
        const snapshotPromise = loadLatestSnapshotChanges(codeFournisseur);

        const [
            articles,
            mensuelRows,
            gammeMap,
            nomMap,
            stockMap,
            commandesMap,
            prixVenteMap,
        ] = await Promise.all([
            articlesPromise,
            pgGetMensuelByFournisseur(codeFournisseur, dateDebut, dateFin).catch(e => { console.error("[getProductRows] pgGetMensuelByFournisseur ERROR:", e); return []; }),
            pgGetGammesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetGammesByFournisseur ERROR:", e); return new Map<string, string>(); }),
            pgGetNomenclatureByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetNomenclatureByFournisseur ERROR:", e); return new Map(); }),
            pgGetStockByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetStockByFournisseur ERROR:", e); return new Map<string, PgStockRow[]>(); }),
            pgGetCommandesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetCommandesByFournisseur ERROR:", e); return new Map<string, number>(); }),
            pgGetPrixVenteByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetPrixVenteByFournisseur ERROR:", e); return new Map<string, Record<string, number>>(); }),
        ]);

        console.log(`[getProductRows] ${articles.length} articles, ${mensuelRows.length} mensuel rows, ${gammeMap.size} gammes`);

        // ─── Phase 2 : Fenêtre temporelle 12 mois complets ───────────────────
        const sortedPeriods = last12Periods();
        const allowedPeriods = new Set(sortedPeriods);

        // ─── Phase 3 : Seed productMap depuis articles ────────────────────────
        const productMap = new Map<string, ProductRow>();
        for (const art of articles) {
            if (!art.codein || productMap.has(art.codein)) continue;
            productMap.set(art.codein, {
                codein: art.codein,
                codeFournisseur: art.codefou ?? codeFournisseur,
                nomFournisseur: art.nomfou ?? "",
                fournisseurPrincipalCode: art.codefou_principal ?? undefined,
                fournisseurPrincipalNom: art.nomfou_principal ?? undefined,
                libelle1: art.libelle1 ?? "",
                gtin: art.gtin ?? "",
                reference: art.reference ?? "",
                codeCentrale: art.codeCentrale ? String(art.codeCentrale).trim() : undefined,
                code1: "", libelleNiveau1: "",
                code2: "", libelleNiveau2: "",
                code3: "", libelle3: "",
                codeGamme: null,
                codeGammeInit: null,
                codeGammeDraft: null,
                sales12m: {},
                stock12m: {},
                receptions12m: {},
                totalQuantite: 0,
                totalCa: 0,
                totalMarge: 0,
                tauxMarge: 0,
                workingStores: [],
                noid: art.no_id ? Number(art.no_id) : undefined,
                pcb: art.pcb ? Number(art.pcb) : undefined,
                prixVente: art.pv_central ? Number(art.pv_central) : undefined,
            });
        }

        // ─── Phase 4 : Agréger mensuelRows → byPeriod par codein ─────────────
        // SQL a déjà fait l'agrégation par (codein, site, mois).
        // On somme les 2 sites (TOTAL) ET on accumule par site pour le switch client-side.
        type PeriodData = { qty: number; ca: number; marge: number; stock: number; receptions: number };
        const mensuelByCodein = new Map<string, Map<string, PeriodData>>();
        const mensuelBySite = new Map<string, Map<string, Map<string, PeriodData>>>(); // codein → site → periode → data
        const storeMonthsByCodein = new Map<string, Map<string, Set<string>>>();

        for (const row of mensuelRows) {
            const periode = row.mois.replace("-", ""); // "2026-02" → "202602"
            if (!allowedPeriods.has(periode)) continue;

            // Accumulation TOTAL (toujours tous sites)
            if (!mensuelByCodein.has(row.codein)) mensuelByCodein.set(row.codein, new Map());
            const byPeriod = mensuelByCodein.get(row.codein)!;
            if (!byPeriod.has(periode)) byPeriod.set(periode, { qty: 0, ca: 0, marge: 0, stock: 0, receptions: 0 });
            const p = byPeriod.get(periode)!;
            p.stock      += Number(row.stock_fin_mois) || 0;
            p.qty        += Number(row.qte_vendue)     || 0;
            p.ca         += Number(row.ca_ht)          || 0;
            p.marge      += Number(row.marge)          || 0;
            p.receptions += Number(row.qte_recue)      || 0;

            // Accumulation par site (pour switch client-side)
            if (!mensuelBySite.has(row.codein)) mensuelBySite.set(row.codein, new Map());
            const bySite = mensuelBySite.get(row.codein)!;
            if (!bySite.has(row.site)) bySite.set(row.site, new Map());
            const siteByPeriod = bySite.get(row.site)!;
            if (!siteByPeriod.has(periode)) siteByPeriod.set(periode, { qty: 0, ca: 0, marge: 0, stock: 0, receptions: 0 });
            const sp = siteByPeriod.get(periode)!;
            sp.qty        += Number(row.qte_vendue)     || 0;
            sp.ca         += Number(row.ca_ht)          || 0;
            sp.marge      += Number(row.marge)          || 0;
            sp.stock       = Number(row.stock_fin_mois) || 0; // SQL donne déjà le dernier mouvement
            sp.receptions += Number(row.qte_recue)      || 0;

            // Suivi magasins actifs (pour workingStores) : 1 vente suffit
            if (Number(row.qte_vendue) > 0) {
                if (!storeMonthsByCodein.has(row.codein)) storeMonthsByCodein.set(row.codein, new Map());
                storeMonthsByCodein.get(row.codein)!.set(row.site, new Set());
            }
        }

        // ─── Phase 5 : Remplir ProductRow depuis mensuelByCodein ─────────────
        for (const [codein, byPeriod] of mensuelByCodein.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;

            let lastStock = 0;
            for (const periode of sortedPeriods) {
                const p = byPeriod.get(periode);
                if (p) {
                    product.sales12m[periode]      = p.qty;
                    product.stock12m[periode]      = p.stock;
                    product.receptions12m[periode] = p.receptions;
                    product.totalQuantite += p.qty;
                    product.totalCa       += p.ca;
                    product.totalMarge    += p.marge;
                    lastStock = p.stock;
                } else {
                    product.sales12m[periode]      = 0;
                    product.stock12m[periode]      = lastStock; // carry-forward
                    product.receptions12m[periode] = 0;
                }
            }

            product.tauxMarge = product.totalCa > 0 ? (product.totalMarge / product.totalCa) * 100 : 0;

            // Breakdowns par site pour le switch client-side
            const siteMap = mensuelBySite.get(codein);
            if (siteMap) {
                product.sales12mByStore       = {};
                product.stock12mByStore       = {};
                product.receptions12mByStore  = {};
                product.caByStore             = {};
                product.quantiteByStore       = {};
                product.margeByStore          = {};
                for (const [site, siteByPeriod] of siteMap.entries()) {
                    product.sales12mByStore[site]      = {};
                    product.stock12mByStore[site]      = {};
                    product.receptions12mByStore![site] = {};
                    let sQty = 0, sCa = 0, sMarge = 0;
                    let lastSiteStock = 0;
                    for (const periode of sortedPeriods) {
                        const sp = siteByPeriod.get(periode);
                        product.sales12mByStore[site][periode]      = sp?.qty        ?? 0;
                        product.receptions12mByStore![site][periode] = sp?.receptions ?? 0;
                        if (sp) {
                            product.stock12mByStore[site][periode] = sp.stock;
                            lastSiteStock = sp.stock;
                        } else {
                            product.stock12mByStore[site][periode] = lastSiteStock; // carry-forward
                        }
                        sQty   += sp?.qty   ?? 0;
                        sCa    += sp?.ca    ?? 0;
                        sMarge += sp?.marge ?? 0;
                    }
                    product.quantiteByStore[site] = sQty;
                    product.caByStore[site]       = sCa;
                    product.margeByStore[site]    = sMarge;
                }

                // Le stock TOTAL se recalcule ici, à partir des séries par site.
                //
                // Il était sommé plus haut depuis les lignes mensuelles brutes, ce
                // qui perdait tout magasin SANS MOUVEMENT dans le mois : le stock
                // est un niveau, pas un flux — un magasin qui n'a rien vendu ni reçu
                // détient toujours sa marchandise. Sur un produit à faible rotation,
                // « tous magasins » n'affichait donc que le site actif, en pratique
                // Frouard. Les séries par site, elles, sont reportées d'un mois sur
                // l'autre : leur somme est la bonne.
                const sites = Object.keys(product.stock12mByStore);
                if (sites.length > 0) {
                    for (const periode of sortedPeriods) {
                        product.stock12m[periode] = sites.reduce(
                            (total, site) => total + (product.stock12mByStore![site][periode] ?? 0),
                            0,
                        );
                    }
                }
            }

            // workingStores : sites avec au moins 1 vente sur les 12 derniers mois
            const storeMonths = storeMonthsByCodein.get(codein);
            if (storeMonths) {
                product.workingStores = [...storeMonths.keys()].sort();
            }

            // Commandes en cours
            const cmdQty = commandesMap.get(codein);
            if (cmdQty) product.commandesEnCours = cmdQty;
        }

        // ─── Phase 6 : Gammes (saison active) ────────────────────────────────
        for (const [codein, gammeCode] of gammeMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;
            product.codeGammeInit = gammeCode as GammeCode;
            product.codeGamme     = gammeCode as GammeCode;
        }

        // ─── Phase 6b : Nomenclature (famille / sous-famille) ────────────────
        for (const [codein, nom] of nomMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;
            product.code3          = nom.code3       ?? "";
            product.libelle3       = nom.libelle3     ?? "";
            product.code2          = nom.code2        ?? "";
            product.libelleNiveau2 = nom.libelle2     ?? "";
            product.code1          = nom.code1        ?? "";
            product.libelleNiveau1 = nom.libelle1nom  ?? "";
        }

        // ─── Phase 7 : Stock temps réel (cube_stock) ─────────────────────────
        for (const [codein, stocks] of stockMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;

            const sitesStock = stocks;

            product.stockActuel = sitesStock.reduce((s, r) => s + (Number(r.stockdispo) || 0), 0);
            product.stockTotal  = sitesStock.reduce((s, r) => s + (Number(r.qte)         || 0), 0);
            product.stockValeur = sitesStock.reduce((s, r) => s + (Number(r.valstock)    || 0), 0);

            const withPrmp = sitesStock.find(r => Number(r.prmp) > 0);
            if (withPrmp) {
                product.pa        = Number(withPrmp.prmp);
                product.prixAchat = product.pa;
            }

            const dernVente = sitesStock.reduce<string>((best, r) =>
                r.dernierevente && r.dernierevente > best ? r.dernierevente : best, "");
            if (dernVente) product.derniereVente = dernVente;

            const dernLiv = sitesStock.reduce<string>((best, r) =>
                r.dernierereception && r.dernierereception > best ? r.dernierereception : best, "");
            if (dernLiv) product.derniereLivraison = dernLiv;

            // Map store-specific delivery dates
            product.derniereLivraisonByStore = {};
            for (const r of sitesStock) {
                if (r.site && r.dernierereception) {
                    product.derniereLivraisonByStore[r.site] = r.dernierereception;
                }
            }
        }

        // ─── Phase 7b : Prix de vente (cube_pv, sinon le PV du cube de stock) ─
        //
        // `article_infosup.prix_vente_mini`, renseigné en Phase 3, n'est qu'une
        // borne de paramétrage : elle est vide en base et laissait la colonne PV
        // entièrement creuse. Le vrai prix vit dans `cube_pv`, par article ET par
        // site. On garde le détail par magasin — deux magasins peuvent ne pas
        // pratiquer le même prix, et l'afficher vaut mieux que le moyenner.
        for (const product of productMap.values()) {
            const parSite = prixVenteMap.get(product.codein);
            if (parSite && Object.keys(parSite).length > 0) {
                product.prixVenteByStore = parSite;
            } else {
                // Filet de secours : le cube de stock porte le même PV, mais
                // seulement pour les articles qui ont une ligne de stock.
                const depuisStock: Record<string, number> = {};
                for (const s of stockMap.get(product.codein) ?? []) {
                    const pv = Number(s.pv);
                    const site = String(s.site ?? "").trim();
                    if (site && Number.isFinite(pv) && pv > 0) depuisStock[site] = pv;
                }
                if (Object.keys(depuisStock).length > 0) product.prixVenteByStore = depuisStock;
            }

            const prix = Object.values(product.prixVenteByStore ?? {});
            // Le plus élevé quand les magasins divergent : une moyenne inventerait
            // un prix qu'aucune caisse ne pratique. L'écart est signalé à l'écran.
            if (prix.length > 0) product.prixVente = Math.max(...prix);
        }

        // ─── Phase 8 : Données réseau Qlik (CA / Qté / nb magasins par code centrale) ──
        enrichWithNetworkMetrics(productMap, await networkPromise);

        // ─── Phase 9 : Restaurer gammes depuis dernier snapshot ──────────────
        // La colonne Gamme (codeGamme) conserve la valeur du snapshot telle quelle.
        // La colonne INIT (codeGammeInit) reste, elle, l'état LIVE du serveur
        // rechargé en Phase 6 — jamais écrasée ici.
        applySnapshotChanges(productMap.values(), await snapshotPromise);

        // ─── Phase 10 : Filtrer gamme Y sans ventes ──────────────────────────
        const allRows = Array.from(productMap.values());
        const rows = allRows.filter(p => p.codeGamme !== "Y" || p.totalQuantite > 0);
        await reconcileSelectedStoreFromMensuelApi(rows, magasin, dateDebut, dateFin, sortedPeriods);
        const excludedY = allRows.length - rows.length;
        console.log(`[getProductRows] ${rows.length} produits (${excludedY} gamme Y sans ventes exclus), ${mensuelByCodein.size} avec ventes`);

        return rows;

    } catch (error) {
        console.error(`[getProductRows] Error for ${codeFournisseur}:`, error);
        // Ne PAS renvoyer [] : une liste vide est indiscernable d'un fournisseur
        // sans article. La Grille affichait une page blanche sans explication, et
        // la synchro nocturne prenait la panne pour un fournisseur vide — qu'elle
        // désactivait alors automatiquement. La remonter laisse chaque appelant la
        // traiter comme une erreur (bandeau rouge, statut « echec »).
        throw error instanceof Error
            ? error
            : new Error(`Calcul de la grille impossible pour ${codeFournisseur} : ${String(error)}`);
    }
}

/** Articles complétés par l'API FF, au plus, lors d'un changement de magasin. */
function plafondComplement(): number {
    return Number(process.env.GRID_STORE_RECONCILE_MAX ?? 300);
}

/** Interroge l'API FF pour les articles du magasin à compléter (cf. store-patch). */
async function fetchStorePatchEntries(
    rows: ProductRow[],
    magasin: string,
    dateDebut: string,
    dateFin: string,
    periods: string[],
): Promise<StorePatchEntry[]> {
    const candidates = storePatchCandidates(rows, magasin);
    if (candidates.length === 0) return [];

    // Ce rattrapage fait UNE requête HTTP par article : sur un gros fournisseur,
    // les candidats se comptent par milliers et le changement de magasin se fige
    // plusieurs minutes. On le borne, et on dit ce qui a été laissé de côté
    // plutôt que de tronquer en silence.
    const PLAFOND = plafondComplement();
    const retenus = candidates.slice(0, PLAFOND);
    if (candidates.length > retenus.length) {
        console.warn(
            `[getProductRows] rattrapage magasin ${magasin} borné à ${retenus.length} articles`
            + ` sur ${candidates.length} : les autres gardent la valeur SQL.`,
        );
    }

    const mensuelMap = await getMensuelByArticles(
        retenus.map((row) => ({
            codein: row.codein,
            libelle1: row.libelle1,
            codefou: row.codeFournisseur,
            noid: row.noid,
        })),
        dateDebut,
        dateFin,
        25
    );
    return buildStorePatchEntries(retenus, magasin, periods, mensuelMap);
}

async function reconcileSelectedStoreFromMensuelApi(
    rows: ProductRow[],
    magasin: string,
    dateDebut: string,
    dateFin: string,
    sortedPeriods: string[]
) {
    if (magasin === "TOTAL") return;
    try {
        const entries = await fetchStorePatchEntries(rows, magasin, dateDebut, dateFin, sortedPeriods);
        const fixedRows = applyStorePatchInPlace(rows, magasin, sortedPeriods, entries);
        if (fixedRows > 0) {
            console.log(`[getProductRows] ${fixedRows} produits corrigés via API mensuelle pour magasin ${magasin}`);
        }
    } catch (error) {
        console.error("[getProductRows] Mensuel API reconciliation error:", error);
    }
}

/**
 * Compléments par magasin, rattachés au tableau de lignes « tous magasins » en
 * cache : ils vivent et meurent avec lui (expiration, « Actualiser », nouvel
 * enregistrement), sans autre invalidation à gérer.
 */
const storePatches = new WeakMap<ProductRow[], Map<string, Promise<StorePatch>>>();

/**
 * Complément de l'API FF pour un magasin, calculé sur les lignes « tous
 * magasins » (jamais modifiées ici). La Grille l'applique à son arrivée, sans
 * recharger les lignes. Les demandes simultanées partagent le même calcul, et
 * un échec n'est jamais gardé.
 */
export async function getStorePatch(codeFournisseur: string, magasin: string): Promise<StorePatch> {
    const enCache = gridRowsCache.get(`${codeFournisseur}:TOTAL`);
    const rows = enCache && Date.now() - enCache.createdAt < GRID_ROWS_CACHE_TTL_MS
        ? enCache.rows
        : await getProductRows({ codeFournisseur, magasin: "TOTAL" });

    let parMagasin = storePatches.get(rows);
    if (!parMagasin) {
        parMagasin = new Map();
        storePatches.set(rows, parMagasin);
    }
    let patch = parMagasin.get(magasin);
    if (!patch) {
        const periods = last12Periods();
        const { dateDebut, dateFin } = buildLast12MonthsRange();
        const enCours = fetchStorePatchEntries(rows, magasin, dateDebut, dateFin, periods)
            .then((entries): StorePatch => ({ magasin, periods, entries }));
        const table = parMagasin;
        enCours.catch(() => {
            if (table.get(magasin) === enCours) table.delete(magasin);
        });
        parMagasin.set(magasin, enCours);
        patch = enCours;
    }
    return patch;
}

/**
 * Extrait la série « nombre de magasins vendeurs » du détail mensuel complet.
 *
 * `metricsByMonth` porte les cinq mesures Qlik du mois ; seule `nbMag` sert à la
 * deuxième courbe de la carte tendance. Renvoie `null` plutôt qu'un objet vide
 * pour que l'UI distingue « pas de donnée » de « zéro magasin ».
 */
function nbMagParMois(
    metricsByMonth: Record<string, { nbMag?: number }> | null | undefined,
): Record<string, number> | null {
    if (!metricsByMonth) return null;
    const parMois: Record<string, number> = {};
    for (const [mois] of Object.entries(metricsByMonth)) {
        // Un mois PRÉSENT dans le détail est un mois extrait : s'il n'a pas de
        // `nbMag`, c'est qu'aucun magasin n'a vendu, donc zéro. Le traiter comme
        // « manquant » amputait la série et faisait disparaître toute la courbe
        // (les anciens caches n'écrivaient `nbMag` que sur les mois avec vente).
        const nb = Number(metricsByMonth[mois]?.nbMag);
        parMois[mois] = Number.isFinite(nb) ? nb : 0;
    }
    return Object.keys(parMois).length > 0 ? parMois : null;
}

type SnapshotChanges = Record<string, { before: string | null; after: string }>;

/**
 * Phase 9 : la colonne Gamme (codeGamme) reprend la valeur du snapshot ;
 * codeGammeInit reste figé (état serveur).
 */
function applySnapshotChanges(rows: Iterable<ProductRow>, changes: SnapshotChanges | null): void {
    if (!changes) return;
    for (const row of rows) {
        const change = changes[row.codein];
        if (change?.after) row.codeGamme = change.after as GammeCode;
    }
}

/** Dernières gammes enregistrées pour ce fournisseur (Phase 9), ou `null`. */
async function loadLatestSnapshotChanges(codeFournisseur: string): Promise<SnapshotChanges | null> {
    try {
        const snaps = await db
            .select({ changes: sessionSnapshots.changes })
            .from(sessionSnapshots)
            .where(eq(sessionSnapshots.codeFournisseur, codeFournisseur))
            .orderBy(desc(sessionSnapshots.createdAt))
            .limit(1);
        return snaps.length > 0 ? (snaps[0].changes as SnapshotChanges) : null;
    } catch (snapErr) {
        console.error("[getProductRows] Snapshot restore error:", snapErr);
        return null;
    }
}

/**
 * Lit les metriques reseau Qlik (cache qlik_network_metrics) des codes centraux
 * donnes. `null` en cas d'erreur : la grille s'affiche alors sans donnees reseau.
 */
async function fetchNetworkMetrics(
    codesCentrale: string[],
): Promise<Map<string, NetworkMetricCached> | null> {
    try {
        const codes = [...new Set(codesCentrale.filter(Boolean))];
        if (codes.length === 0) return null;
        return await getNetworkMetricsByCodeCentrale(codes);
    } catch (error) {
        console.error("[getProductRows] enrichWithNetworkMetrics error:", error);
        return null;
    }
}

/**
 * Enrichit les produits avec les metriques reseau Qlik, jointes par code centrale.
 * Degradation propre si la sync Qlik n'a jamais tourne ou si le code centrale
 * n'est pas encore disponible.
 */
function enrichWithNetworkMetrics(
    productMap: Map<string, ProductRow>,
    metrics: Map<string, NetworkMetricCached> | null,
): void {
    if (!metrics || metrics.size === 0) return;
    for (const product of productMap.values()) {
        const m = product.codeCentrale ? metrics.get(product.codeCentrale) : undefined;
        if (!m) continue;
        product.caReseau = m.caReseau;
        product.qteReseau = m.qteReseau;
        product.nbMagasinsReseau = m.nbMagasinsReseau;
        product.caParMagasinReseau = m.caParMagasinReseau;
        product.margePctReseau = m.margePctReseau;
        product.tauxPresenceReseau = m.nbMagasinsReseau / NB_MAGASINS_RESEAU;
        product.qteReseauByMonth = m.qteByMonth ?? null;
        product.nbMagReseauByMonth = nbMagParMois(m.metricsByMonth);
        product.networkFetchedAt = m.fetchedAt ?? undefined;
    }
}
