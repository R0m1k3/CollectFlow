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

    // 1. Trouver les valeurs maximales (les "Top 1") pour indexer 0-100
    const maxQty = Math.max(...rows.map((r) => r.totalQuantite ?? 0));
    const maxCa = Math.max(...rows.map((r) => r.totalCa ?? 0));
    const maxMarge = Math.max(...rows.map((r) => r.totalMarge ?? 0));

    // 2. Pour chaque produit, calculer le score relatif au Top 1
    for (const row of rows) {
        // Score de 0 à 100 sur chaque axe (le Top 1 a 100)
        const scoreQty = maxQty > 0 ? ((row.totalQuantite ?? 0) / maxQty) * 100 : 0;
        const scoreCa = maxCa > 0 ? ((row.totalCa ?? 0) / maxCa) * 100 : 0;
        const scoreMarge = maxMarge > 0 ? ((row.totalMarge ?? 0) / maxMarge) * 100 : 0;

        // Base = meilleur score d'axe
        const base = Math.max(scoreQty, scoreCa, scoreMarge);

        // Bonus polyvalence : combien d'axes dépassent le seuil demandé (en %, c.a.d en score d'axe)
        // Attention : settings.seuilAxeFort était pensé pour un % du Total (~2%). 
        // Maintenant le score max étant 100, un "axe fort" devrait plutôt être un paramètre indexé (ex: > 30% du max).
        // On va garder la règle, mais l'utilisateur devra probablement ajuster le seuil dans les paramètres.

        let axesForts = 0;
        if (scoreQty > settings.seuilAxeFort) axesForts++;
        if (scoreCa > settings.seuilAxeFort) axesForts++;
        if (scoreMarge > settings.seuilAxeFort) axesForts++;

        const bonus = axesForts * settings.bonusParAxe;

        row.score = Math.round(Math.min(base + bonus, 100) * 10) / 10;
    }

    return rows;
}
