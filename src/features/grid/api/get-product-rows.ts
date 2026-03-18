"use server";

import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";
import {
    getArticlesByFournisseur,
    getMensuelByArticles,
    getReferentielByArticles,
    getCommandesByFournisseur,
    buildLast12MonthsRange,
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
    console.log(`\n>>> [getProductRows] supplier: ${codeFournisseur}, magasin: ${magasin}`);

    try {
        // ─── Phase 1 : Articles du fournisseur ───────────────────────────────
        const articles = await getArticlesByFournisseur(codeFournisseur);
        console.log(`[getProductRows] ${articles.length} articles for ${codeFournisseur}`);

        // ─── Phase 2 : Mensuel + Commandes (en parallèle) ────────────────────
        const { dateDebut, dateFin } = buildLast12MonthsRange();
        const [mensuelMap, referentielMap, commandesMap] = await Promise.all([
            getMensuelByArticles(articles, dateDebut, dateFin),
            getReferentielByArticles(articles),
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
                    receptions12m: {},
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

        // Log de TOUS les sites distincts sur l'ensemble des articles (diagnostic double-comptage)
        const allSites = new Set<string>();
        for (const entries of mensuelMap.values()) {
            for (const e of entries as import("@/lib/api-ff-client").FfMensuelEntry[]) allSites.add(e.site);
        }
        console.log(`[getProductRows] Tous les sites distincts dans mensuel: ${JSON.stringify([...allSites])}`);
        // Compter combien d'entrées par site (pour détecter la centrale)
        const siteCount: Record<string, number> = {};
        for (const entries of mensuelMap.values()) {
            for (const e of entries as import("@/lib/api-ff-client").FfMensuelEntry[]) {
                siteCount[e.site] = (siteCount[e.site] ?? 0) + 1;
            }
        }
        console.log(`[getProductRows] Entrées par site: ${JSON.stringify(siteCount)}`);

        for (const [codein, entries] of mensuelMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;

            // Agréger par période (toutes les entrées site × mois → 1 entrée par mois)
            const byPeriod = new Map<string, { qty: number; ca: number; marge: number; stock: number; pa: number; receptions: number }>();
            const storeMonths = new Map<string, Set<string>>(); // site → Set<YYYYMM>

            for (const entry of entries) {
                // Garder uniquement les sites physiques (292, 579) — exclure la centrale (agrégat)
                if (filterSite) {
                    if (entry.site !== filterSite) continue;
                } else {
                    if (entry.site !== "292" && entry.site !== "579") continue;
                }

                const periode = entry.mois.replace("-", ""); // "2026-02" → "202602"
                if (!allowedPeriods.has(periode)) continue;

                if (!byPeriod.has(periode)) {
                    byPeriod.set(periode, { qty: 0, ca: 0, marge: 0, stock: 0, pa: 0, receptions: 0 });
                }
                const p = byPeriod.get(periode)!;

                // Stock fin de mois : somme tous sites (ou site filtré)
                p.stock += Math.abs(parseFloat(entry.stock_fin_mois ?? "0") || 0);
                if (!p.pa && entry.prmp_fin_mois) p.pa = parseFloat(entry.prmp_fin_mois) || 0;

                // Réceptions
                if (entry.receptions) {
                    p.receptions += Math.abs(parseFloat(entry.receptions.qte_recue ?? "0") || 0);
                }

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
                    product.sales12m[periode]      = p.qty;
                    product.stock12m[periode]      = p.stock;
                    product.receptions12m[periode] = p.receptions;
                    product.totalQuantite += p.qty;
                    product.totalCa       += p.ca;
                    product.totalMarge    += p.marge;
                    lastStock = p.stock;
                    if (!lastPa && p.pa) lastPa = p.pa;
                } else {
                    product.sales12m[periode]      = 0;
                    product.stock12m[periode]      = lastStock; // carry-forward
                    product.receptions12m[periode] = 0;
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

        // ─── Phase 6 : Classification depuis referentiel API (nomenclature + gamme) ─
        let refCount = 0;
        for (const [codein, ref] of referentielMap.entries()) {
            const product = productMap.get(codein);
            if (!product) continue;

            // Nomenclature
            product.code3    = ref.article.nom_code    ?? "";
            product.libelle3 = ref.article.nom_libelle ?? "";

            // Gamme initiale (figée) + gamme courante (sera overridée par snapshot si besoin)
            const gammeCode = ref.gammes?.[0]?.gamme_code ?? null;
            product.codeGammeInit = gammeCode;
            product.codeGamme     = gammeCode;

            // PA et PCB depuis referentiel (plus précis que articles endpoint)
            const pa = parseFloat(ref.prix?.achat ?? "0") || 0;
            if (pa > 0) { product.pa = pa; product.prixAchat = pa; }
            const pcb = parseFloat(ref.fournisseurs?.[0]?.pcb ?? "0") || 0;
            if (pcb > 0) product.pcb = pcb;

            // Stock actuel agrégé tous sites (valeur temps réel)
            if (ref.stock?.length) {
                product.stockActuel = ref.stock.reduce((sum, s) => sum + (parseFloat(s.stockdispo ?? "0") || 0), 0);
                product.stockTotal  = ref.stock.reduce((sum, s) => sum + (parseFloat(s.qte        ?? "0") || 0), 0);
                product.stockValeur = ref.stock.reduce((sum, s) => sum + (parseFloat(s.valstock   ?? "0") || 0), 0);
                const firstSite = ref.stock.find(s => parseFloat(s.prmp ?? "0") > 0);
                if (firstSite && !product.pa) { product.pa = parseFloat(firstSite.prmp); product.prixAchat = product.pa; }
            }

            // Dernière vente depuis performance
            if (ref.performance?.derniere_vente) product.derniereVente = ref.performance.derniere_vente;
            if (ref.performance?.derniere_entree) product.derniereLivraison = ref.performance.derniere_entree;

            refCount++;
        }
        console.log(`[getProductRows] Referentiel: ${refCount}/${articles.length} articles enrichis`);

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
                        // codeGammeInit reste figé (valeur d'origine depuis ventesProduits)
                        product.codeGamme = change.after as GammeCode;
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
