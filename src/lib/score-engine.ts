/**
 * CollectFlow — Score Engine v2 (Simplifié - Score de Contribution Composite)
 *
 * Calcule le score de performance d'un produit basé sur sa contribution RELATIVE
 * à la moyenne de son lot fournisseur sur 3 axes : CA, Quantité, Marge.
 *
 * Formule :
 *   Score = (40% × Score_CA) + (35% × Score_Volume) + (25% × Score_Marge)
 *
 * Où chaque score d'axe est :
 *   Score_Axe = (Valeur Produit / Moyenne Fournisseur) × 100
 *
 * Exemples :
 *   - Score = 100 → Le produit fait exactement sa part
 *   - Score = 150 → Le produit surperforme de 50%
 *   - Score = 50  → Le produit sous-performe de 50%
 *
 * Avantages :
 *   - Simple et intuitif
 *   - Auto-normalisé (fonctionne avec 5 ou 50 produits)
 *   - Reflète la VRAIE contribution du produit
 *   - Aligné avec l'analyse IA v5
 */

import type { ProductRow } from "@/types/grid";

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

    const avgCa = rows.length > 0 ? totalCa / rows.length : 0;
    const avgQty = rows.length > 0 ? totalQty / rows.length : 0;
    const avgMarge = rows.length > 0 ? totalMarge / rows.length : 0;

    // 3. Calculer les totaux pour les poids (%)
    const rayonTotals = new Map<string, { total: number; count: number }>();
    weightedData.forEach((d) => {
        const r2 = d.row.code2 || "default";
        const current = rayonTotals.get(r2) || { total: 0, count: 0 };
        rayonTotals.set(r2, { total: current.total + d.wQty, count: current.count + 1 });
    });

    // 4. Pour chaque produit : calculer le score composite
    for (const data of weightedData) {
        // Injection des métriques de contexte (pour l'IA et l'affichage)
        data.row.avgQtyFournisseur = avgQty;
        data.row.totalFournisseurCa = totalCa;

        // Calcul des poids (%)
        data.row.shareQty = totalQty > 0 ? (data.wQty / totalQty) * 100 : 0;
        data.row.shareCa = totalCa > 0 ? (data.wCa / totalCa) * 100 : 0;
        data.row.shareMarge = totalMarge > 0 ? (data.tauxMarge / totalMarge) * 100 : 0;

        const r2 = data.row.code2 || "default";
        const rayonStat = rayonTotals.get(r2);
        data.row.avgQtyRayon = rayonStat ? rayonStat.total / rayonStat.count : 0;

        // ================================================================
        // SCORE DE CONTRIBUTION COMPOSITE
        // ================================================================

        // Score de chaque axe = (Valeur Produit / Moyenne Fournisseur) × 100
        const scoreCa = avgCa > 0 ? (data.wCa / avgCa) * 100 : 0;
        const scoreVolume = avgQty > 0 ? (data.wQty / avgQty) * 100 : 0;
        const scoreMarge = avgMarge > 0 ? (data.tauxMarge / avgMarge) * 100 : 0;

        // Validation des pondérations (garde contre undefined/NaN)
        const wCA = Number.isFinite(settings.weightCA) ? settings.weightCA : 0.40;
        const wVol = Number.isFinite(settings.weightVolume) ? settings.weightVolume : 0.35;
        const wMarge = Number.isFinite(settings.weightMarge) ? settings.weightMarge : 0.25;

        // Score final = moyenne pondérée
        const scoreComposite = (wCA * scoreCa) + (wVol * scoreVolume) + (wMarge * scoreMarge);

        // Arrondi à 1 décimale, garde contre NaN
        data.row.score = Number.isFinite(scoreComposite) ? Math.round(scoreComposite * 10) / 10 : 0;
    }

    return rows;
}
