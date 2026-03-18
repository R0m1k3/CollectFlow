"use server";

import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";
import {
    getArticlesByFournisseur,
    getMouvementsByFournisseur,
    getStockByFournisseur,
    getCommandesByFournisseur,
    buildLast12MonthsRange,
    dateToYYYYMM,
} from "@/lib/api-ff-client";
import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
}

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL" } = input;
    console.log(`\n>>> [getProductRows] RECEIVED CALL for supplier: ${codeFournisseur}, magasin: ${magasin}`);

    try {
        // ─── Phase 1 : Articles du fournisseur ───────────────────────────────
        const articles = await getArticlesByFournisseur(codeFournisseur);
        console.log(`[getProductRows] ${articles.length} articles found for ${codeFournisseur}`);

        // ─── Phase 2 : Mouvements (ventes + stock12m) ────────────────────────
        const { dateDebut, dateFin } = buildLast12MonthsRange();
        const mouvements = await getMouvementsByFournisseur(codeFournisseur, dateDebut, dateFin);
        console.log(`[getProductRows] ${mouvements.length} mouvements found`);

        // ─── Phase 3 : Stock & Commandes (en parallèle) ──────────────────────
        const [stockMap, commandesMap] = await Promise.all([
            getStockByFournisseur(articles),
            getCommandesByFournisseur(codeFournisseur),
        ]);

        // ─── Phase 4 : Fenêtre temporelle (12 mois complets) ─────────────────
        // En mars 2026 → allowedPeriods = {"202503"..."202602"} (12 mois)
        const now = new Date();
        const allowedPeriods = new Set<string>();
        for (let i = 12; i >= 1; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            allowedPeriods.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
        }

        // ─── Phase 5 : Seed productMap depuis articles ────────────────────────
        const productMap = new Map<string, ProductRow>();
        const storeParticipationMap = new Map<string, Map<string, Set<string>>>();
        // stockMaxByPeriod[codein][YYYYMM] = dernier qtestock du mois
        const stockLastByPeriod = new Map<string, Map<string, { qtestock: number; datemvt: string }>>();

        for (const art of articles) {
            if (!productMap.has(art.codein)) {
                productMap.set(art.codein, {
                    codein: art.codein,
                    codeFournisseur: art.codefou ?? codeFournisseur,
                    nomFournisseur: art.nomfou ?? "",
                    libelle1: art.libelle1 ?? "",
                    gtin: "",
                    reference: "",
                    code1: "",
                    libelleNiveau1: "",
                    code2: "",
                    libelleNiveau2: "",
                    code3: "",
                    libelle3: "",
                    codeGamme: null,
                    codeGammeInit: null,
                    codeGammeDraft: null,
                    sales12m: {},
                    stock12m: {},
                    totalQuantite: 0,
                    totalCa: 0,
                    totalMarge: 0,
                    tauxMarge: 0,
                    score: 0,
                    workingStores: [],
                    aiRecommendation: null,
                    pcb: art.pcb,
                    prixVente: art.pv_central,
                });
            }
        }

        // ─── Phase 6 : Agréger mouvements → sales12m + stock12m ─────────────
        for (const mvt of mouvements) {
            const { codein, genremvt, datemvt, qte, montant, marge, qtestock, site } = mvt;

            // Filtre magasin
            if (magasin !== "TOTAL" && site !== magasin) continue;

            const periode = dateToYYYYMM(datemvt);
            const isInPeriod = allowedPeriods.has(periode);

            const product = productMap.get(codein);
            if (!product) continue;

            // Participation magasin (pour workingStores)
            if (isInPeriod && site && site !== "TOTAL") {
                if (!storeParticipationMap.has(codein)) storeParticipationMap.set(codein, new Map());
                const stores = storeParticipationMap.get(codein)!;
                if (!stores.has(site)) stores.set(site, new Set());
                stores.get(site)!.add(periode);
            }

            // Ventes (genremvt = 3)
            if (isInPeriod && genremvt === 3) {
                const qty = Math.abs(qte ?? 0);
                const ca = Math.abs(montant ?? 0);
                const mg = Math.abs(marge ?? 0);
                product.sales12m[periode] = (product.sales12m[periode] ?? 0) + qty;
                product.totalQuantite += qty;
                product.totalCa += ca;
                product.totalMarge += mg;
            }

            // Stock12m : conserver le dernier mouvement par mois (via qtestock)
            // On inclut tous les mouvements (pas que les ventes) pour avoir le stock fin de mois
            if (isInPeriod) {
                if (!stockLastByPeriod.has(codein)) stockLastByPeriod.set(codein, new Map());
                const byPeriod = stockLastByPeriod.get(codein)!;
                const existing = byPeriod.get(periode);
                if (!existing || datemvt >= existing.datemvt) {
                    byPeriod.set(periode, { qtestock, datemvt });
                }
            }
        }

        // Calcul tauxMarge + reconstruction stock12m avec carry-forward
        for (const [codein, product] of productMap.entries()) {
            product.tauxMarge = product.totalCa > 0
                ? (product.totalMarge / product.totalCa) * 100
                : 0;

            // Reconstruction stock12m avec carry-forward
            const byPeriod = stockLastByPeriod.get(codein);
            if (byPeriod) {
                const sortedPeriods = [...allowedPeriods].sort();
                let lastKnownStock = 0;
                for (const p of sortedPeriods) {
                    const entry = byPeriod.get(p);
                    if (entry !== undefined) {
                        lastKnownStock = entry.qtestock;
                    }
                    product.stock12m[p] = lastKnownStock;
                }
            }
        }

        // ─── Phase 7 : workingStores ─────────────────────────────────────────
        for (const [codein, product] of productMap.entries()) {
            const stores = storeParticipationMap.get(codein);
            if (stores) {
                const working: string[] = [];
                for (const [site, periods] of stores.entries()) {
                    if (site !== "TOTAL" && periods.size >= 3) working.push(site);
                }
                product.workingStores = working.sort();
            }
        }

        // ─── Phase 8 : Enrichir avec stockMap ────────────────────────────────
        for (const [codein, product] of productMap.entries()) {
            const stock = stockMap.get(codein);
            if (stock) {
                product.stockActuel = stock.stockActuel;
                product.stockTotal = stock.stockTotal;
                product.stockValeur = stock.stockValeur;
                product.pa = stock.pa;
                product.prixAchat = stock.pa;
                product.derniereVente = stock.derniereVente || undefined;
                product.derniereLivraison = stock.derniereLivraison || undefined;
                product.nbJoursDerniereVente = stock.nbJoursDerniereVente;
            }
            const cmdQty = commandesMap.get(codein);
            if (cmdQty) product.commandesEnCours = cmdQty;
        }

        // ─── Phase 8b : Restaurer gammes depuis dernier snapshot ─────────────
        try {
            const snapshots = await db
                .select()
                .from(sessionSnapshots)
                .where(eq(sessionSnapshots.codeFournisseur, codeFournisseur))
                .orderBy(desc(sessionSnapshots.createdAt))
                .limit(1);

            if (snapshots.length > 0) {
                const snap = snapshots[0];
                const changes = snap.changes as Record<string, { before: string | null; after: string }>;
                for (const [codein, change] of Object.entries(changes)) {
                    const product = productMap.get(codein);
                    if (product && change.after) {
                        product.codeGamme = change.after as GammeCode;
                        product.codeGammeInit = change.before as GammeCode | null;
                    }
                }
                console.log(`[getProductRows] Restored ${Object.keys(changes).length} gammes from snapshot ${snap.id}`);
            }
        } catch (snapErr) {
            console.error("[getProductRows] Failed to restore gammes from snapshot:", snapErr);
        }

        // ─── Phase 9 : Score composite ────────────────────────────────────────
        const rows = Array.from(productMap.values());
        console.log(`[getProductRows] Final: ${rows.length} products`);
        return computeProductScores(rows);

    } catch (error) {
        console.error(`[getProductRows] Error for supplier ${codeFournisseur}:`, error);
        return [];
    }
}
