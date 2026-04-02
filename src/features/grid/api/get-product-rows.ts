"use server";

import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";
import { buildLast12MonthsRange } from "@/lib/api-ff-client";
import {
    pgGetArticlesByFournisseur,
    pgGetMensuelByFournisseur,
    pgGetGammesByFournisseur,
    pgGetNomenclatureByFournisseur,
    pgGetStockByFournisseur,
    pgGetRankingByFournisseur,
    pgGetCommandesByFournisseur,
    type PgStockRow,
} from "@/lib/pg-ff-client";
import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
}

// ─── Fonction interne : fetch complet non-paginé (cachée) ───────────────────
// Cette fonction est le « dataloader » central. Elle est enveloppée dans
// unstable_cache pour ne jamais refaire les 6 requêtes SQL tant que le cache
// est valide (revalidate : 300s). Le tag permet une invalidation ciblée.
async function _fetchAllProductRows(codeFournisseur: string): Promise<ProductRow[]> {
    const magasin = "TOTAL"; // Le cache est toujours TOTAL ; le switch magasin est client-side
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
            rankingResult,
            commandesMap,
        ] = await Promise.all([
            pgGetArticlesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetArticlesByFournisseur ERROR:", e); return []; }),
            pgGetMensuelByFournisseur(codeFournisseur, dateDebut, dateFin).catch(e => { console.error("[getProductRows] pgGetMensuelByFournisseur ERROR:", e); return []; }),
            pgGetGammesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetGammesByFournisseur ERROR:", e); return new Map<string, string>(); }),
            pgGetNomenclatureByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetNomenclatureByFournisseur ERROR:", e); return new Map(); }),
            pgGetStockByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetStockByFournisseur ERROR:", e); return new Map<string, PgStockRow[]>(); }),
            pgGetRankingByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetRankingByFournisseur ERROR:", e); return { rankings: new Map(), totalRankedProducts: 0 }; }),
            pgGetCommandesByFournisseur(codeFournisseur).catch(e => { console.error("[getProductRows] pgGetCommandesByFournisseur ERROR:", e); return new Map<string, number>(); }),
        ]);

        const { rankings: rankingMap, totalRankedProducts } = rankingResult;
        console.log(`[getProductRows] ${articles.length} articles, ${mensuelRows.length} mensuel rows, ${gammeMap.size} gammes, ${rankingMap.size} rankings`);

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
                libelle1: art.libelle1 ?? "",
                gtin: art.gtin ?? "",
                reference: art.reference ?? "",
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
                score: 0,
                workingStores: [],
                aiRecommendation: null,
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
        }

        // ─── Phase 8 : Ranking réseau ────────────────────────────────────────
        for (const [codein, ranking] of rankingMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;
            product.rankingCa           = ranking.ranking_ca    ? Number(ranking.ranking_ca)    : undefined;
            product.rankingQte          = ranking.ranking_qte   ? Number(ranking.ranking_qte)   : undefined;
            product.rankingMagCa        = ranking.ranking_mag_ca  ? Number(ranking.ranking_mag_ca)  : undefined;
            product.rankingMagQte       = ranking.ranking_mag_qte ? Number(ranking.ranking_mag_qte) : undefined;
            product.totalRankedProducts = totalRankedProducts;
        }

        // ─── Phase 9 : Restaurer gammes depuis dernier snapshot ──────────────
        try {
            const snaps = await db
                .select()
                .from(sessionSnapshots)
                .where(eq(sessionSnapshots.codeFournisseur, codeFournisseur))
                .orderBy(desc(sessionSnapshots.createdAt))
                .limit(1);

            if (snaps.length > 0) {
                const changes = snaps[0].changes as Record<string, { before: string | null; after: string }>;
                for (const [codein, change] of Object.entries(changes)) {
                    const product = productMap.get(codein);
                    if (product && change.after) {
                        // codeGammeInit reste figé — seulement codeGamme est overridé
                        product.codeGamme = change.after as GammeCode;
                    }
                }
                console.log(`[getProductRows] Gammes restaurées depuis snapshot`);
            }
        } catch (snapErr) {
            console.error("[getProductRows] Snapshot restore error:", snapErr);
        }

        // ─── Phase 10 : Filtrer gamme Y sans ventes + compute scores ─────────
        const allRows = Array.from(productMap.values());
        const rows = allRows.filter(p => p.codeGamme !== "Y" || p.totalQuantite > 0);
        const excludedY = allRows.length - rows.length;
        console.log(`[getProductRows] ${rows.length} produits (${excludedY} gamme Y sans ventes exclus), ${mensuelByCodein.size} avec ventes`);

        return computeProductScores(rows);

    } catch (error) {
        console.error(`[_fetchAllProductRows] Error for ${codeFournisseur}:`, error);
        return [];
    }
}

// ─── Fonction publique ─────────────
/**
 * Point d'entrée unique pour la grille.
 * - Retourne toutes les lignes (filtrage/tri restent côté client)
 */
export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur } = input;
    
    // Appel direct sans l'enveloppe dynamique de unstable_cache qui cause un freeze/timeout
    return _fetchAllProductRows(codeFournisseur);
}
