"use server";

import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";
import {
    getArticlesByFournisseur,
    getMensuelByArticles,
    getCommandesByFournisseur,
    buildLast12MonthsRange,
} from "@/lib/api-ff-client";
import { db } from "@/db";
import { sessionSnapshots, ventesProduits } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
}

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL" } = input;
    console.log(`\n>>> [getProductRows] supplier: ${codeFournisseur}, magasin: ${magasin}`);

    try {
        // ─── Phase 1 : Articles du fournisseur ───────────────────────────────
        const articles = await getArticlesByFournisseur(codeFournisseur);
        console.log(`[getProductRows] ${articles.length} articles for ${codeFournisseur}`);

        // ─── Phase 2 : Mensuel + Commandes (en parallèle) ────────────────────
        const { dateDebut, dateFin } = buildLast12MonthsRange();
        const [mensuelMap, commandesMap] = await Promise.all([
            getMensuelByArticles(articles, dateDebut, dateFin),
            getCommandesByFournisseur(codeFournisseur),
        ]);
        console.log(`[getProductRows] mensuel data for ${mensuelMap.size}/${articles.length} articles`);

        // ─── Phase 3 : Fenêtre temporelle (12 mois complets) ─────────────────
        const now = new Date();
        const allowedPeriods = new Set<string>();
        for (let i = 12; i >= 1; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            allowedPeriods.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
        }
        const sortedPeriods = [...allowedPeriods].sort(); // "202503" … "202602"

        // ─── Phase 4 : Seed productMap depuis articles ────────────────────────
        const productMap = new Map<string, ProductRow>();
        for (const art of articles) {
            if (!productMap.has(art.codein)) {
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
                    totalQuantite: 0,
                    totalCa: 0,
                    totalMarge: 0,
                    tauxMarge: 0,
                    score: 0,
                    workingStores: [],
                    aiRecommendation: null,
                    pcb: art.pcb ? Number(art.pcb) : undefined,
                    prixVente: art.pv_central ? Number(art.pv_central) : undefined,
                });
            }
        }

        // ─── Phase 5 : Agréger données mensuelles → sales12m + stock12m ──────
        const filterSite = magasin !== "TOTAL" ? magasin : null;

        for (const [codein, entries] of mensuelMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;

            // Agréger par période (toutes les entrées site × mois → 1 entrée par mois)
            const byPeriod = new Map<string, { qty: number; ca: number; marge: number; stock: number; pa: number }>();
            const storeMonths = new Map<string, Set<string>>(); // site → Set<YYYYMM>

            for (const entry of entries) {
                if (filterSite && entry.site !== filterSite) continue;

                const periode = entry.mois.replace("-", ""); // "2026-02" → "202602"
                if (!allowedPeriods.has(periode)) continue;

                if (!byPeriod.has(periode)) {
                    byPeriod.set(periode, { qty: 0, ca: 0, marge: 0, stock: 0, pa: 0 });
                }
                const p = byPeriod.get(periode)!;

                // Stock fin de mois : somme tous sites (ou site filtré)
                p.stock += Math.abs(parseFloat(entry.stock_fin_mois ?? "0") || 0);
                if (!p.pa && entry.prmp_fin_mois) p.pa = parseFloat(entry.prmp_fin_mois) || 0;

                // Ventes
                if (entry.ventes) {
                    p.qty  += Math.abs(parseFloat(entry.ventes.qte_vendue ?? "0") || 0);
                    p.ca   += Math.abs(parseFloat(entry.ventes.ca_ht       ?? "0") || 0);
                    p.marge += parseFloat(entry.ventes.marge               ?? "0") || 0;

                    // Suivi magasins actifs (pour workingStores)
                    if (entry.site && entry.site !== "TOTAL") {
                        if (!storeMonths.has(entry.site)) storeMonths.set(entry.site, new Set());
                        storeMonths.get(entry.site)!.add(periode);
                    }
                }
            }

            // Remplir sales12m / stock12m avec carry-forward sur les mois sans données
            let lastStock = 0;
            let lastPa = 0;
            for (const periode of sortedPeriods) {
                const p = byPeriod.get(periode);
                if (p) {
                    product.sales12m[periode] = p.qty;
                    product.stock12m[periode] = p.stock;
                    product.totalQuantite += p.qty;
                    product.totalCa       += p.ca;
                    product.totalMarge    += p.marge;
                    lastStock = p.stock;
                    if (!lastPa && p.pa) lastPa = p.pa;
                } else {
                    product.sales12m[periode] = 0;
                    product.stock12m[periode] = lastStock; // carry-forward
                }
            }

            product.tauxMarge  = product.totalCa > 0 ? (product.totalMarge / product.totalCa) * 100 : 0;
            product.pa         = lastPa > 0 ? lastPa : undefined;
            product.prixAchat  = lastPa > 0 ? lastPa : undefined;
            product.stockActuel = product.stock12m[sortedPeriods[sortedPeriods.length - 1]] ?? 0;

            // workingStores : sites avec ventes sur >= 3 mois distincts
            product.workingStores = [...storeMonths.entries()]
                .filter(([, periods]) => periods.size >= 3)
                .map(([site]) => site)
                .sort();

            // Commandes en cours
            const cmdQty = commandesMap.get(codein);
            if (cmdQty) product.commandesEnCours = cmdQty;
        }

        // ─── Phase 6 : Classification depuis ventesProduits (lecture seule) ──
        // Source de vérité pour : codeGamme initial, codeGammeInit, code3, libelle3
        try {
            const classifRows = await db.execute(sql`
                SELECT DISTINCT ON (codein)
                    codein, code_gamme, code_gamme_init, code3, libelle3
                FROM ventes_produits
                WHERE code_fournisseur = ${codeFournisseur}
                ORDER BY codein, updated_at DESC
            `);
            for (const row of classifRows.rows) {
                const product = productMap.get(row.codein as string);
                if (product) {
                    product.codeGamme     = (row.code_gamme     as string | null) ?? null;
                    product.codeGammeInit = (row.code_gamme_init as string | null) ?? null;
                    product.code3         = (row.code3          as string | null) ?? "";
                    product.libelle3      = (row.libelle3        as string | null) ?? "";
                }
            }
            console.log(`[getProductRows] Classification chargée pour ${classifRows.rows.length} lignes`);
        } catch (classifErr) {
            console.warn("[getProductRows] ventesProduits classification non disponible:", classifErr);
        }

        // ─── Phase 7 : Restaurer gammes depuis dernier snapshot ──────────────
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
                        product.codeGamme     = change.after as GammeCode;
                        product.codeGammeInit = change.before as GammeCode | null;
                    }
                }
                console.log(`[getProductRows] Gammes restaurées depuis snapshot`);
            }
        } catch (snapErr) {
            console.error("[getProductRows] Snapshot restore error:", snapErr);
        }

        // ─── Phase 7 : Score composite ────────────────────────────────────────
        const rows = Array.from(productMap.values());
        console.log(`[getProductRows] ${rows.length} produits, ${mensuelMap.size} avec données`);
        return computeProductScores(rows);

    } catch (error) {
        console.error(`[getProductRows] Error for ${codeFournisseur}:`, error);
        return [];
    }
}
