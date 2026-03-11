/**
 * CollectFlow — Score Engine (Proposition C: Score Composite Pondéré)
 *
 * Calcule le score de performance d'un produit en fonction de son poids
 * relatif chez le fournisseur sur 3 axes : CA, Quantité, Marge.
 *
 * Formule :
 *   score_axe = produit.metric / max_metric_fournisseur × 100
 *   base  = (scoreCa × 45%) + (scoreQty × 35%) + (scoreMarge × 20%)
 *   bonus = count(poids > seuil) × bonusParAxe
 *   score = MIN(base + bonus, 100)
 */

import type { ProductRow } from "@/types/grid";

export interface ScoreSettings {
    /** Seuil en % pour considérer un axe comme "fort" (défaut: 2.0) */
    seuilAxeFort: number;
    /** Points bonus par axe dépassant le seuil (défaut: 5) */
    bonusParAxe: number;
}

export const DEFAULT_SCORE_SETTINGS: ScoreSettings = {
    seuilAxeFort: 30.0,
    bonusParAxe: 10,
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

    // 1. Calculer les valeurs pondérées pour tout le monde et trouver les max
    const weightedData = rows.map((r) => {
        const weight = (r.workingStores?.length || 1) === 1 ? 2 : 1;
        return {
            row: r,
            wQty: (r.totalQuantite ?? 0) * weight,
            wCa: (r.totalCa ?? 0) * weight,
            wMarge: (r.totalMarge ?? 0) * weight,
        };
    });

    const maxQty = weightedData.reduce((max, d) => Math.max(max, d.wQty), 0);
    const maxCa = weightedData.reduce((max, d) => Math.max(max, d.wCa), 0);
    const maxMarge = weightedData.reduce((max, d) => Math.max(max, d.wMarge), 0);

    // 2. Calculer les moyennes et totaux globaux
    const totalQty = weightedData.reduce((acc, d) => acc + d.wQty, 0);
    const totalCa = weightedData.reduce((acc, d) => acc + d.wCa, 0);
    const totalMarge = weightedData.reduce((acc, d) => acc + d.wMarge, 0);

    const avgQtyFournisseur = rows.length > 0 ? totalQty / rows.length : 0;

    const rayonTotals = new Map<string, { total: number, count: number }>();
    weightedData.forEach(d => {
        const r2 = d.row.code2 || "default";
        const current = rayonTotals.get(r2) || { total: 0, count: 0 };
        rayonTotals.set(r2, { total: current.total + d.wQty, count: current.count + 1 });
    });

    // 3. Pour chaque produit, calculer le score relatif et injecter les contextes (poids, moyennes)
    for (const data of weightedData) {
        // Injection des métriques de poids et contextes
        data.row.avgQtyFournisseur = avgQtyFournisseur;
        data.row.totalFournisseurCa = totalCa;

        // Calcul des poids (%)
        data.row.shareQty = totalQty > 0 ? (data.wQty / totalQty) * 100 : 0;
        data.row.shareCa = totalCa > 0 ? (data.wCa / totalCa) * 100 : 0;
        data.row.shareMarge = totalMarge > 0 ? (data.wMarge / totalMarge) * 100 : 0;

        const r2 = data.row.code2 || "default";
        const rayonStat = rayonTotals.get(r2);
        data.row.avgQtyRayon = rayonStat ? rayonStat.total / rayonStat.count : 0;

        // Score de 0 à 100 sur chaque axe pondéré
        const scoreQty = maxQty > 0 ? (data.wQty / maxQty) * 100 : 0;
        const scoreCa = maxCa > 0 ? (data.wCa / maxCa) * 100 : 0;
        const scoreMarge = maxMarge > 0 ? (data.wMarge / maxMarge) * 100 : 0;

        // Base = Moyenne pondérée (CA: 45%, Qty: 35%, Marge: 20%)
        const base = (scoreCa * 0.45) + (scoreQty * 0.35) + (scoreMarge * 0.20);

        let axesForts = 0;
        if (scoreQty > settings.seuilAxeFort) axesForts++;
        if (scoreCa > settings.seuilAxeFort) axesForts++;
        if (scoreMarge > settings.seuilAxeFort) axesForts++;

        const bonus = axesForts * settings.bonusParAxe;

        data.row.score = Math.round(Math.min(base + bonus, 100) * 10) / 10;
    }

    return rows;
}
