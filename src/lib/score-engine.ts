/**
 * CollectFlow — Score Engine v4 (Hybride Absolu + Relatif)
 *
 * Calcule le score de performance d'un produit en combinant :
 * - Performance ABSOLUE : Volume (50pts), CA (30pts), Marge (20pts)
 * - Ajustement RELATIF  : Position dans le lot fournisseur (±10pts)
 * - Pénalité de régularité : multiplicateur si inactivité prolongée
 *
 * Score final : 0-100, sensible au prix unitaire.
 *
 * Exemples :
 *   - 0.80€ × 100 unités (80€ CA) → ~53 (bon trafic malgré petit CA)
 *   - 40€ × 2 unités (80€ CA)     → ~19 (faible rotation)
 *   - 500€ CA, 200u, 45% marge    → ~90 (star)
 *   - 8€ CA, 2 unités              → ~13 (stock mort)
 */

import type { ProductRow } from "@/types/grid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Interpolation linéaire entre deux paliers */
function lerp(value: number, minVal: number, maxVal: number, minPts: number, maxPts: number): number {
    if (value >= maxVal) return maxPts;
    if (value <= minVal) return minPts;
    return minPts + ((value - minVal) / (maxVal - minVal)) * (maxPts - minPts);
}

/** Score Volume (0-50) basé sur unités / magasin / mois */
function computeVolumeScore(unitsPerStorePerMonth: number): number {
    if (unitsPerStorePerMonth >= 10) return 50;
    if (unitsPerStorePerMonth >= 5) return lerp(unitsPerStorePerMonth, 5, 10, 40, 50);
    if (unitsPerStorePerMonth >= 2) return lerp(unitsPerStorePerMonth, 2, 5, 30, 40);
    if (unitsPerStorePerMonth >= 1) return lerp(unitsPerStorePerMonth, 1, 2, 20, 30);
    if (unitsPerStorePerMonth >= 0.5) return lerp(unitsPerStorePerMonth, 0.5, 1, 10, 20);
    return lerp(unitsPerStorePerMonth, 0, 0.5, 0, 10);
}

/** Score CA (0-30) basé sur CA € / magasin / an */
function computeCaScore(caPerStorePerYear: number): number {
    if (caPerStorePerYear >= 500) return 30;
    if (caPerStorePerYear >= 200) return lerp(caPerStorePerYear, 200, 500, 22, 30);
    if (caPerStorePerYear >= 100) return lerp(caPerStorePerYear, 100, 200, 15, 22);
    if (caPerStorePerYear >= 50) return lerp(caPerStorePerYear, 50, 100, 8, 15);
    return lerp(caPerStorePerYear, 0, 50, 0, 8);
}

/** Score Marge (0-20) basé sur taux de marge % */
function computeMargeScore(tauxMarge: number): number {
    if (tauxMarge >= 50) return 20;
    if (tauxMarge >= 40) return lerp(tauxMarge, 40, 50, 16, 20);
    if (tauxMarge >= 30) return lerp(tauxMarge, 30, 40, 12, 16);
    if (tauxMarge >= 20) return lerp(tauxMarge, 20, 30, 8, 12);
    return lerp(tauxMarge, 0, 20, 0, 8);
}

/** Rangs percentiles (0-100) pour un tableau de valeurs numériques. */
function computePercentileRanks(values: number[]): number[] {
    const n = values.length;
    if (n === 0) return [];
    if (n === 1) return [50];

    const indexed = values.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);

    const ranks = new Array<number>(n);
    let i = 0;
    while (i < n) {
        let j = i;
        while (j < n && indexed[j].v === indexed[i].v) j++;
        const avgRank = ((i + j - 1) / 2) / (n - 1) * 100;
        for (let k = i; k < j; k++) {
            ranks[indexed[k].i] = Math.round(avgRank);
        }
        i = j;
    }

    return ranks;
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Calcule les scores pour un ensemble de produits d'un même fournisseur.
 * Les rows sont modifiées en place et retournées.
 */
export function computeProductScores(rows: ProductRow[]): ProductRow[] {
    if (rows.length === 0) return rows;

    // 1. Données pondérées pour normalisation multi-magasins
    const weightedData = rows.map((r) => {
        const storeCount = Math.max(1, r.workingStores?.length || 1);
        const weight = storeCount === 1 ? 2 : 1;

        // Régularité : nombre de mois avec au moins 1 vente
        const regScore = Object.values(r.sales12m || {}).filter((v) => v > 0).length;

        // Inactivité : mois sans vente en fin de fenêtre
        const allMonths = Object.keys(r.sales12m || {});
        const refMonth = allMonths.length > 0 ? Math.max(...allMonths.map(m => parseInt(m))).toString() : "";
        const salesMonths = Object.entries(r.sales12m || {})
            .filter(([, qty]) => qty > 0)
            .map(([m]) => parseInt(m))
            .sort((a, b) => b - a);
        const lastSaleMonth = salesMonths.length > 0 ? salesMonths[0].toString() : "";

        let inactivity = 0;
        if (refMonth && lastSaleMonth) {
            const refY = parseInt(refMonth.substring(0, 4));
            const refM = parseInt(refMonth.substring(4, 6));
            const lastY = parseInt(lastSaleMonth.substring(0, 4));
            const lastM = parseInt(lastSaleMonth.substring(4, 6));
            inactivity = (refY - lastY) * 12 + (refM - lastM);
        } else if (refMonth && !lastSaleMonth) {
            // Jamais vendu sur la fenêtre → inactivité maximale
            inactivity = 24;
        }

        return {
            row: r,
            storeCount,
            weight,
            wQty: (r.totalQuantite ?? 0) * weight,
            wCa: (r.totalCa ?? 0) * weight,
            tauxMarge: Number.isFinite(r.tauxMarge) ? r.tauxMarge : 0,
            regScore,
            inactivity,
        };
    });

    // 2. Totaux fournisseur
    const totalQty = weightedData.reduce((acc, d) => acc + d.wQty, 0);
    const totalCa = weightedData.reduce((acc, d) => acc + d.wCa, 0);
    const totalMarge = weightedData.reduce((sum, d) => sum + d.tauxMarge, 0);
    const avgQty = rows.length > 0 ? totalQty / rows.length : 0;

    // 3. Totaux par rayon (code2)
    const rayonTotals = new Map<string, { total: number; count: number }>();
    weightedData.forEach((d) => {
        const r2 = d.row.code2 || "default";
        const current = rayonTotals.get(r2) || { total: 0, count: 0 };
        rayonTotals.set(r2, { total: current.total + d.wQty, count: current.count + 1 });
    });

    // 4. Percentiles dans le lot (pour le bonus relatif)
    const caPctRanks = computePercentileRanks(weightedData.map(d => d.wCa));
    const qtyPctRanks = computePercentileRanks(weightedData.map(d => d.wQty));
    const margePctRanks = computePercentileRanks(weightedData.map(d => d.tauxMarge));

    // 5. Seuil top 30% CA pour le flag isTop30Supplier
    const sortedCa = [...weightedData.map(d => d.wCa)].sort((a, b) => b - a);
    const top30Idx = Math.max(0, Math.ceil(sortedCa.length * 0.3) - 1);
    const top30CaThreshold = sortedCa[top30Idx] ?? 0;

    // 6. Score de chaque produit
    for (let idx = 0; idx < weightedData.length; idx++) {
        const d = weightedData[idx];
        const r = d.row;

        // --- Guard absolu : aucune vente → score 0, quelle que soit la marge ou le ranking ---
        if (d.wQty === 0 && d.wCa === 0) {
            r.avgQtyFournisseur   = avgQty;
            r.totalFournisseurCa  = totalCa;
            r.shareQty            = 0;
            r.shareCa             = 0;
            r.shareMarge          = 0;
            const r2z             = r.code2 || "default";
            const rStat           = rayonTotals.get(r2z);
            r.avgQtyRayon         = rStat ? rStat.total / rStat.count : 0;
            r.unitsPerStorePerMonth = 0;
            r.caPerStorePerYear   = 0;
            r.score               = 0;
            r.isRecent            = true;
            r.isLastProduct       = rows.length === 1;
            r.isTop30Supplier     = false;
            continue;
        }

        // --- Métriques de contexte (inchangées, pour l'IA et l'affichage) ---
        r.avgQtyFournisseur = avgQty;
        r.totalFournisseurCa = totalCa;
        r.shareQty = totalQty > 0 ? (d.wQty / totalQty) * 100 : 0;
        r.shareCa = totalCa > 0 ? (d.wCa / totalCa) * 100 : 0;
        r.shareMarge = totalMarge > 0 ? (d.tauxMarge / totalMarge) * 100 : 0;

        const r2 = r.code2 || "default";
        const rayonStat = rayonTotals.get(r2);
        r.avgQtyRayon = rayonStat ? rayonStat.total / rayonStat.count : 0;

        // --- KPIs normalisés (sensibles au prix) ---
        const activeMonths = Math.max(d.regScore, 3); // plancher 3 mois
        const unitsPerStorePerMonth = d.wQty / (d.storeCount * activeMonths);
        const caPerStorePerYear = d.wCa / d.storeCount;

        r.unitsPerStorePerMonth = Math.round(unitsPerStorePerMonth * 100) / 100;
        r.caPerStorePerYear = Math.round(caPerStorePerYear * 100) / 100;

        // --- Score absolu (Volume + CA + Marge = 0-100 pts) ---
        const volumeScore = computeVolumeScore(unitsPerStorePerMonth);
        const caScore = computeCaScore(caPerStorePerYear);
        const margeScore = computeMargeScore(d.tauxMarge);

        // --- Bonus relatif (±10 pts) ---
        const pctComposite = (caPctRanks[idx] * 0.40 + qtyPctRanks[idx] * 0.35 + margePctRanks[idx] * 0.25);
        const relativeBonus = ((pctComposite - 50) / 50) * 10;

        // --- Pénalité de régularité ---
        let regularityMultiplier = 1;
        if (d.regScore <= 2 && d.inactivity >= 6) {
            regularityMultiplier = 0.3;
        } else if (d.regScore <= 2 && d.inactivity >= 3) {
            regularityMultiplier = 0.5;
        } else if (d.inactivity >= 6) {
            regularityMultiplier = 0.5;
        } else if (d.inactivity >= 3) {
            regularityMultiplier = 0.7;
        }

        // --- Score final ---
        const rawScore = (volumeScore + caScore + margeScore + relativeBonus) * regularityMultiplier;
        r.score = Math.round(Math.max(0, Math.min(100, rawScore)) * 10) / 10;

        // --- Flags de protection ---
        r.isRecent = d.regScore <= 3;
        r.isLastProduct = rows.length === 1;
        r.isTop30Supplier = d.wCa >= top30CaThreshold && top30CaThreshold > 0;
    }

    return rows;
}
