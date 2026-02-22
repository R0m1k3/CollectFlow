/**
 * CollectFlow — Score Engine (Proposition B: MAX + Bonus polyvalence)
 *
 * Calcule le score de performance d'un produit en fonction de son poids
 * relatif chez le fournisseur sur 3 axes : Quantité, CA, Marge.
 *
 * Formule :
 *   poids = produit.metric / total_fournisseur × 100
 *   base  = MAX(poids_qty, poids_ca, poids_marge)
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

    const maxQty = Math.max(...weightedData.map((d) => d.wQty));
    const maxCa = Math.max(...weightedData.map((d) => d.wCa));
    const maxMarge = Math.max(...weightedData.map((d) => d.wMarge));

    // 2. Pour chaque produit, calculer le score relatif aux max pondérés
    for (const data of weightedData) {
        // Score de 0 à 100 sur chaque axe pondéré (le Top 1 pondéré a 100)
        const scoreQty = maxQty > 0 ? (data.wQty / maxQty) * 100 : 0;
        const scoreCa = maxCa > 0 ? (data.wCa / maxCa) * 100 : 0;
        const scoreMarge = maxMarge > 0 ? (data.wMarge / maxMarge) * 100 : 0;

        // Base = meilleur score d'axe
        const base = Math.max(scoreQty, scoreCa, scoreMarge);

        let axesForts = 0;
        if (scoreQty > settings.seuilAxeFort) axesForts++;
        if (scoreCa > settings.seuilAxeFort) axesForts++;
        if (scoreMarge > settings.seuilAxeFort) axesForts++;

        const bonus = axesForts * settings.bonusParAxe;

        data.row.score = Math.round(Math.min(base + bonus, 100) * 10) / 10;
    }

    return rows;
}
