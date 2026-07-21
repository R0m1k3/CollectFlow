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
    type PgStockRow,
} from "@/lib/pg-ff-client";
import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getNetworkMetricsByCodeCentrale } from "@/lib/qlik-network-cache";

const NB_MAGASINS_RESEAU = 270;

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
    forceRefresh?: boolean;
}

const GRID_ROWS_CACHE_TTL_MS = 10 * 60 * 1000;
const gridRowsCache = new Map<string, { rows: ProductRow[]; createdAt: number }>();
const gridRowsPending = new Map<string, Promise<ProductRow[]>>();

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

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const cacheKey = gridRowsCacheKey(input);
    const cached = gridRowsCache.get(cacheKey);
    if (!input.forceRefresh && cached && Date.now() - cached.createdAt < GRID_ROWS_CACHE_TTL_MS) {
        return cached.rows;
    }

    const pending = gridRowsPending.get(cacheKey);
    if (!input.forceRefresh && pending) {
        return pending;
    }

    const promise = buildProductRows(input).then((rows) => {
        gridRowsCache.set(cacheKey, { rows, createdAt: Date.now() });
        gridRowsPending.delete(cacheKey);
        return rows;
    }).catch((error) => {
        gridRowsPending.delete(cacheKey);
        throw error;
    });

    gridRowsPending.set(cacheKey, promise);
    return promise;
}

async function buildProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL" } = input;
    console.log(`\n>>> [getProductRows] supplier: ${codeFournisseur}, magasin: ${magasin}`);

    try {
        const { dateDebut, dateFin } = buildLast12MonthsRange();

        // ─── Phase 1 : 6 requêtes SQL en parallèle ────────────────────────────
        // Remplace des centaines/milliers d'appels HTTP per-article.
        const [
            articles,
            mensuelRows,
            gammeMap,
            nomMap,
            stockMap,
            commandesMap,
        ] = await Promise.all([
            pgGetArticlesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetArticlesByFournisseur ERROR:", e); return []; }),
            pgGetMensuelByFournisseur(codeFournisseur, dateDebut, dateFin).catch(e => { console.error("[getProductRows] pgGetMensuelByFournisseur ERROR:", e); return []; }),
            pgGetGammesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetGammesByFournisseur ERROR:", e); return new Map<string, string>(); }),
            pgGetNomenclatureByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetNomenclatureByFournisseur ERROR:", e); return new Map(); }),
            pgGetStockByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetStockByFournisseur ERROR:", e); return new Map<string, PgStockRow[]>(); }),
            pgGetCommandesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetCommandesByFournisseur ERROR:", e); return new Map<string, number>(); }),
        ]);

        console.log(`[getProductRows] ${articles.length} articles, ${mensuelRows.length} mensuel rows, ${gammeMap.size} gammes`);

        // ─── Phase 2 : Fenêtre temporelle 12 mois complets ───────────────────
        const now = new Date();
        const allowedPeriods = new Set<string>();
        for (let i = 12; i >= 1; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            allowedPeriods.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
        }
        const sortedPeriods = [...allowedPeriods].sort();

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

        // ─── Phase 8 : Données réseau Qlik (CA / Qté / nb magasins par code centrale) ──
        await enrichWithNetworkMetrics(productMap);

        // ─── Phase 9 : Réappliquer les modifications ENCORE EN ATTENTE ───────
        // codeGammeInit / codeGamme viennent d'être rechargés depuis l'état LIVE
        // du serveur (Phase 6). On ne réapplique une modification du dernier
        // snapshot QUE si elle est toujours en attente côté serveur, c.-à-d. si
        // le serveur est encore sur la valeur d'origine (change.before === gamme
        // live actuelle). Si le serveur a déjà appliqué la modif (gamme live ==
        // after) ou a changé la gamme depuis (gamme live != before), on fait
        // confiance à l'état serveur courant : la grille reflète le réel et la
        // modif n'apparaît plus comme "en attente".
        try {
            const snaps = await db
                .select()
                .from(sessionSnapshots)
                .where(eq(sessionSnapshots.codeFournisseur, codeFournisseur))
                .orderBy(desc(sessionSnapshots.createdAt))
                .limit(1);

            if (snaps.length > 0) {
                const changes = snaps[0].changes as Record<string, { before: string | null; after: string }>;
                let enAttente = 0;
                let obsoletes = 0;
                for (const [codein, change] of Object.entries(changes)) {
                    const product = productMap.get(codein);
                    if (!product || !change.after) continue;

                    const gammeLive = product.codeGammeInit;                 // état serveur courant
                    const before = change.before ?? null;
                    const stillPending = before === (gammeLive ?? null) && change.after !== gammeLive;

                    if (stillPending) {
                        // Modification pas encore appliquée sur le serveur → on la remonte
                        product.codeGamme = change.after as GammeCode;
                        enAttente++;
                    } else {
                        // Déjà appliquée côté serveur (ou serveur divergent) → on garde le LIVE
                        product.codeGamme = gammeLive;
                        obsoletes++;
                    }
                }
                console.log(`[getProductRows] Snapshot: ${enAttente} modif(s) en attente réappliquée(s), ${obsoletes} déjà appliquée(s)/obsolète(s) ignorée(s)`);
            }
        } catch (snapErr) {
            console.error("[getProductRows] Snapshot restore error:", snapErr);
        }

        // ─── Phase 10 : Filtrer gamme Y sans ventes ──────────────────────────
        const allRows = Array.from(productMap.values());
        const rows = allRows.filter(p => p.codeGamme !== "Y" || p.totalQuantite > 0);
        await reconcileSelectedStoreFromMensuelApi(rows, magasin, dateDebut, dateFin, sortedPeriods);
        const excludedY = allRows.length - rows.length;
        console.log(`[getProductRows] ${rows.length} produits (${excludedY} gamme Y sans ventes exclus), ${mensuelByCodein.size} avec ventes`);

        return rows;

    } catch (error) {
        console.error(`[getProductRows] Error for ${codeFournisseur}:`, error);
        return [];
    }
}

async function reconcileSelectedStoreFromMensuelApi(
    rows: ProductRow[],
    magasin: string,
    dateDebut: string,
    dateFin: string,
    sortedPeriods: string[]
) {
    if (magasin === "TOTAL") return;

    const candidates = rows.filter((row) => {
        if (!row.noid) return false;
        const storeQty = row.quantiteByStore?.[magasin] ?? 0;
        return storeQty === 0;
    });

    if (candidates.length === 0) return;

    try {
        const mensuelMap = await getMensuelByArticles(
            candidates.map((row) => ({
                codein: row.codein,
                libelle1: row.libelle1,
                codefou: row.codeFournisseur,
                noid: row.noid,
            })),
            dateDebut,
            dateFin,
            25
        );

        let fixedRows = 0;
        for (const row of candidates) {
            const entries = (mensuelMap.get(row.codein) ?? []).filter((entry) => entry.site === magasin);
            if (entries.length === 0) continue;

            const byPeriod = new Map<string, { qty: number; ca: number; marge: number; stock: number; receptions: number }>();
            for (const entry of entries) {
                const period = entry.mois.replace("-", "");
                if (!sortedPeriods.includes(period)) continue;
                // qte_vendue / ca_ht sont NÉGATIFS côté API (ventes nettes) : on
                // les nie au lieu de Math.abs pour que les retours restent déduits.
                const qty = -(Number(entry.ventes?.qte_vendue ?? 0) || 0);
                const ca = -(Number(entry.ventes?.ca_ht ?? 0) || 0);
                const marge = Number(entry.ventes?.marge ?? 0) || 0;
                const stock = Number(entry.stock_fin_mois ?? 0) || 0;
                const receptions = Number(entry.receptions?.qte_recue ?? 0) || 0;
                byPeriod.set(period, { qty, ca, marge, stock, receptions });
            }

            const apiQty = [...byPeriod.values()].reduce((sum, value) => sum + value.qty, 0);
            if (apiQty === 0) continue;

            row.sales12mByStore ??= {};
            row.stock12mByStore ??= {};
            row.receptions12mByStore ??= {};
            row.caByStore ??= {};
            row.quantiteByStore ??= {};
            row.margeByStore ??= {};
            row.sales12mByStore[magasin] ??= {};
            row.stock12mByStore[magasin] ??= {};
            row.receptions12mByStore[magasin] ??= {};

            let storeQty = 0;
            let storeCa = 0;
            let storeMarge = 0;
            let lastStock = 0;

            for (const period of sortedPeriods) {
                const value = byPeriod.get(period);
                const currentQty = row.sales12mByStore[magasin][period] ?? 0;
                const nextQty = value?.qty ?? 0;
                const deltaQty = nextQty - currentQty;

                row.sales12mByStore[magasin][period] = nextQty;
                row.receptions12mByStore[magasin][period] = value?.receptions ?? 0;
                if (value) lastStock = value.stock;
                row.stock12mByStore[magasin][period] = lastStock;

                row.sales12m[period] = (row.sales12m[period] ?? 0) + deltaQty;
                storeQty += nextQty;
                storeCa += value?.ca ?? 0;
                storeMarge += value?.marge ?? 0;
            }

            const deltaTotalQty = storeQty - (row.quantiteByStore[magasin] ?? 0);
            const deltaTotalCa = storeCa - (row.caByStore[magasin] ?? 0);
            const deltaTotalMarge = storeMarge - (row.margeByStore[magasin] ?? 0);

            row.quantiteByStore[magasin] = storeQty;
            row.caByStore[magasin] = storeCa;
            row.margeByStore[magasin] = storeMarge;
            row.totalQuantite += deltaTotalQty;
            row.totalCa += deltaTotalCa;
            row.totalMarge += deltaTotalMarge;
            row.tauxMarge = row.totalCa > 0 ? (row.totalMarge / row.totalCa) * 100 : 0;
            if (!row.workingStores.includes(magasin)) row.workingStores.push(magasin);
            fixedRows++;
        }

        if (fixedRows > 0) {
            console.log(`[getProductRows] ${fixedRows} produits corrigés via API mensuelle pour magasin ${magasin}`);
        }
    } catch (error) {
        console.error("[getProductRows] Mensuel API reconciliation error:", error);
    }
}

/**
 * Enrichit les produits avec les metriques reseau Qlik (cache qlik_network_metrics),
 * jointes par code centrale. Degradation propre si la sync Qlik n'a jamais tourne
 * ou si le code centrale n'est pas encore disponible.
 */
async function enrichWithNetworkMetrics(productMap: Map<string, ProductRow>): Promise<void> {
    try {
        const byCodeCentrale = new Map<string, ProductRow[]>();
        for (const product of productMap.values()) {
            const cc = product.codeCentrale;
            if (!cc) continue;
            if (!byCodeCentrale.has(cc)) byCodeCentrale.set(cc, []);
            byCodeCentrale.get(cc)!.push(product);
        }
        if (byCodeCentrale.size === 0) return;

        const metrics = await getNetworkMetricsByCodeCentrale([...byCodeCentrale.keys()]);
        const sampleKey = [...byCodeCentrale.keys()].find((cc) => (metrics.get(cc)?.caReseau ?? 0) > 0) ?? [...byCodeCentrale.keys()].find((cc) => metrics.has(cc));
        console.log(`[getProductRows] réseau: ${byCodeCentrale.size} codes centraux → ${metrics.size} matchés en cache. Sample:`, sampleKey ? JSON.stringify(metrics.get(sampleKey)) : "aucun match");
        for (const [cc, products] of byCodeCentrale.entries()) {
            const m = metrics.get(cc);
            if (!m) continue;
            for (const product of products) {
                product.caReseau = m.caReseau;
                product.qteReseau = m.qteReseau;
                product.nbMagasinsReseau = m.nbMagasinsReseau;
                product.caParMagasinReseau = m.caParMagasinReseau;
                product.margePctReseau = m.margePctReseau;
                product.tauxPresenceReseau = m.nbMagasinsReseau / NB_MAGASINS_RESEAU;
                product.networkFetchedAt = m.fetchedAt ?? undefined;
            }
        }
    } catch (error) {
        console.error("[getProductRows] enrichWithNetworkMetrics error:", error);
    }
}
