/**
 * CollectFlow — Score Engine v3 (Percentile Composite)
 *
 * Calcule le score de performance d'un produit par rang percentile au sein
 * de son lot fournisseur sur 3 axes : CA, Quantité, Taux de Marge.
 *
 * Formule :
 *   Score = (40% × Percentile_CA) + (35% × Percentile_Volume) + (25% × Percentile_Marge)
 *
 * Où chaque Percentile_Axe est le rang du produit dans son lot fournisseur (0-100).
 *
 * Exemples :
 *   - Score = 100 → Meilleur produit du fournisseur sur tous les axes
 *   - Score = 50  → Produit médian du fournisseur
 *   - Score = 0   → Dernier produit du fournisseur sur tous les axes
 *
 * Avantages :
 *   - Borné 0-100 (plus de scores > 150 pour des petits fournisseurs)
 *   - Robuste aux fournisseurs avec peu de références ou faibles volumes
 *   - Cohérent avec le scoring IA (scoring-engine.ts) qui utilise aussi les percentiles
 */

import type { ProductRow } from "@/types/grid";

/**
 * Calcule les rangs percentiles (0-100) pour un tableau de valeurs numériques.
 * Les ex-æquo reçoivent le rang moyen de leur groupe.
 * Cas limite : tableau à 1 élément → [50] (médiane).
 */
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
        // Rang moyen pour les ex-æquo, normalisé 0-100
        const avgRank = ((i + j - 1) / 2) / (n - 1) * 100;
        for (let k = i; k < j; k++) {
            ranks[indexed[k].i] = Math.round(avgRank);
        }
        i = j;
    }

    return ranks;
}

export interface ScoreSettings {
    /** Pondération CA (défaut: 40%) */
    weightCA: number;
    /** Pondération Volume (défaut: 35%) */
    weightVolume: number;
    /** Pondération Marge (défaut: 25%) */
    weightMarge: number;
}

export const DEFAULT_SCORE_SETTINGS: ScoreSettings = {
    weightCA: 0.40,
    weightVolume: 0.35,
    weightMarge: 0.25,
};

/**
 * Calcule les scores pour un ensemble de produits d'un même fournisseur.
 * Les rows sont modifiées en place (champ `score`) et retournées.
 */
export function computeProductScores(
    rows: ProductRow[],
    settings: ScoreSettings = DEFAULT_SCORE_SETTINGS
): ProductRow[] {
    if (rows.length === 0) return rows;

    // 1. Normalisation multi-magasins : pondérer les produits en 1 magasin (×2)
    //    pour comparer équitablement avec ceux en 2 magasins
    const weightedData = rows.map((r) => {
        const storeCount = r.workingStores?.length || 1;
        const weight = storeCount === 1 ? 2 : 1;

        return {
            row: r,
            wQty: (r.totalQuantite ?? 0) * weight,
            wCa: (r.totalCa ?? 0) * weight,
            wMarge: (r.totalMarge ?? 0) * weight,
            tauxMarge: Number.isFinite(r.tauxMarge) ? r.tauxMarge : 0, // Garde contre NaN
        };
    });

    // 2. Calculer les MOYENNES du fournisseur (pas les MAX !)
    const totalQty = weightedData.reduce((acc, d) => acc + d.wQty, 0);
    const totalCa = weightedData.reduce((acc, d) => acc + d.wCa, 0);
    const totalMarge = weightedData.reduce((sum, d) => sum + d.tauxMarge, 0);

    const avgQty = rows.length > 0 ? totalQty / rows.length : 0;

    // 3. Calculer les totaux pour les poids (%)
    const rayonTotals = new Map<string, { total: number; count: number }>();
    weightedData.forEach((d) => {
        const r2 = d.row.code2 || "default";
        const current = rayonTotals.get(r2) || { total: 0, count: 0 };
        rayonTotals.set(r2, { total: current.total + d.wQty, count: current.count + 1 });
    });

    // 4. Calcul des rangs percentiles par axe (0-100, borné)
    const caPctRanks = computePercentileRanks(weightedData.map(d => d.wCa));
    const qtyPctRanks = computePercentileRanks(weightedData.map(d => d.wQty));
    const margePctRanks = computePercentileRanks(weightedData.map(d => d.tauxMarge));

    // Validation des pondérations (garde contre undefined/NaN)
    const wCA = Number.isFinite(settings.weightCA) ? settings.weightCA : 0.40;
    const wVol = Number.isFinite(settings.weightVolume) ? settings.weightVolume : 0.35;
    const wMarge = Number.isFinite(settings.weightMarge) ? settings.weightMarge : 0.25;

    // 5. Pour chaque produit : injecter contexte + score composite percentile
    for (let idx = 0; idx < weightedData.length; idx++) {
        const data = weightedData[idx];

        // Métriques de contexte (pour l'IA et l'affichage)
        data.row.avgQtyFournisseur = avgQty;
        data.row.totalFournisseurCa = totalCa;

        // Poids relatifs (%)
        data.row.shareQty = totalQty > 0 ? (data.wQty / totalQty) * 100 : 0;
        data.row.shareCa = totalCa > 0 ? (data.wCa / totalCa) * 100 : 0;
        data.row.shareMarge = totalMarge > 0 ? (data.tauxMarge / totalMarge) * 100 : 0;

        const r2 = data.row.code2 || "default";
        const rayonStat = rayonTotals.get(r2);
        data.row.avgQtyRayon = rayonStat ? rayonStat.total / rayonStat.count : 0;

        // ================================================================
        // SCORE COMPOSITE PERCENTILE (0-100)
        // ================================================================
        const scoreComposite =
            wCA * caPctRanks[idx] +
            wVol * qtyPctRanks[idx] +
            wMarge * margePctRanks[idx];

        data.row.score = Number.isFinite(scoreComposite) ? Math.round(scoreComposite * 10) / 10 : 0;
    }

    return rows;
}
