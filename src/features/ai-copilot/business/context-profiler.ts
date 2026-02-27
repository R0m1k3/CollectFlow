/**
 * CollectFlow — Context Profiler
 *
 * Génère une fiche de contexte normalisée et adaptative pour chaque produit
 * AVANT de le soumettre à l'IA. Ce profiler se base sur la distribution RÉELLE
 * du lot (fournisseur × rayon) et ne contient aucune règle fixe de seuil.
 *
 * L'objectif est de donner à Mary un contexte statistique riche qui lui permet
 * de raisonner de manière autonome et cohérente, y compris pour les produits
 * à fort volume/faible marge (Générateurs de Trafic) ou à faible volume/forte
 * marge (Contributeurs de Marge).
 */

import type { ProductAnalysisInput } from "../models/ai-analysis.types";
import type { ScoringResult } from "./scoring-engine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Quadrant = "STAR" | "TRAFIC" | "MARGE" | "WATCH";

export interface ProductContextProfile {
    // Identité
    codein: string;
    libelle1: string;
    libelleNiveau2: string;

    // Profil Quadrant (issu de la position Quantité vs Marge dans le lot)
    quadrant: Quadrant;
    quadrantLabel: string;
    quadrantEmoji: string;

    // Percentiles dans le lot fournisseur (0 = plus faible, 100 = meilleur)
    percentileCa: number;
    percentileQty: number;
    percentileMarge: number;
    percentileComposite: number;

    // Poids réels dans le lot fournisseur
    weightCaFournisseur: number;   // % du CA total fournisseur
    weightQtyFournisseur: number;  // % des QTÉ totales fournisseur

    // Poids réels dans le rayon (N2)
    weightCaRayon: number;         // % du CA de sa catégorie N2
    weightQtyRayon: number;        // % des QTÉ de sa catégorie N2

    // Santé temporelle
    tauxMarge: number;
    inactivityMonths: number;
    regularityScore: number;       // Nombre de mois actifs sur 12

    // Contexte du lot
    lotSize: number;
    rayonSize: number;

    // Signaux booléens (calculés sans seuil fixe — relatifs à la distribution)
    isAboveMedianComposite: boolean;
    isTop20Ca: boolean;             // Top 20% CA du fournisseur
    isTop20Qty: boolean;            // Top 20% QTÉ du fournisseur
    isHighVolumeWithLowMargin: boolean; // Vol > P60 ET marge < P40 → Trafic
    isMargePure: boolean;               // Marge > P70 MÊME si vol < médiane → Marge

    // Gardes-fous (issus du ScoringEngine)
    isProtected: boolean;
    protectionReason: string;

    // Règle absolue (seule règle fixe du système)
    scoreCritique: boolean; // score brut < 20 = candidat Z direct
}

// ---------------------------------------------------------------------------
// Helpers statistiques (purs, sans effet de bord)
// ---------------------------------------------------------------------------

/** Calcule le percentile d'une valeur dans une distribution (0 à 100). */
function computePercentile(value: number, distribution: number[]): number {
    if (distribution.length <= 1) return 100;
    const sorted = [...distribution].sort((a, b) => a - b);
    const first = sorted.indexOf(value);
    const last = sorted.lastIndexOf(value);
    if (first === -1) return 0;
    const avgRank = (first + last) / 2;
    return Math.round((avgRank / (sorted.length - 1)) * 100);
}

/** Calcule la médiane d'une liste de nombres. */
function computeMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Retourne la valeur au Pième percentile d'une distribution. */
function valueAtPercentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

/**
 * Extrait la clé de groupement pour le rayon de niveau 2.
 *
 * Règles de priorité :
 *   1. Utilise `codeNomenclatureN2` si disponible (4 premiers chiffres du code à 6 chiffres).
 *   2. Sinon, tente d'extraire les 4 premiers chiffres de `libelleNiveau2`
 *      (fallback si les codes ne sont pas transmis).
 *   3. Sinon, retourne la valeur brute de `libelleNiveau2` pour ne pas perdre le groupement.
 *
 * Cela évite les "faux petits rayons" (groupement trop fin sur N3).
 */
function getRayonKey(p: ProductAnalysisInput): string {
    if (p.codeNomenclatureN2) {
        return p.codeNomenclatureN2;
    }
    // Fallback : si libelleNiveau2 commence par 4 chiffres, les extraire
    const numericPrefix = p.libelleNiveau2?.match(/^(\d{4})/);
    if (numericPrefix) {
        return numericPrefix[1];
    }
    return p.libelleNiveau2 ?? "default";
}

// ---------------------------------------------------------------------------
// Profiler principal
// ---------------------------------------------------------------------------

export class ContextProfiler {
    /**
     * Génère le profil contextuel d'un produit au sein de son lot fournisseur.
     *
     * @param target    - Le produit à profiler
     * @param allProds  - Tous les produits du fournisseur (lot complet)
     * @param scoring   - Résultat du ScoringEngine pour ce produit
     */
    static buildProfile(
        target: ProductAnalysisInput,
        allProds: ProductAnalysisInput[],
        scoring: ScoringResult
    ): ProductContextProfile {
        if (allProds.length === 0) {
            throw new Error("[ContextProfiler] Le lot de produits est vide.");
        }

        // --- 1. Totaux fournisseur ---
        const totalCaFournisseur = allProds.reduce((s, p) => s + (p.totalCa ?? 0), 0);
        const totalQtyFournisseur = allProds.reduce((s, p) => s + (p.totalQuantite ?? 0), 0);

        // --- 2. Totaux du rayon (Niveau 2 de nomenclature = 4 premiers chiffres) ---
        //    On groupe sur le code N2 pour éviter les "faux petits rayons" issus d'un
        //    groupement trop fin sur le niveau 3 (code à 6 chiffres).
        const targetRayonKey = getRayonKey(target);
        const rayonProds = allProds.filter(p => getRayonKey(p) === targetRayonKey);
        const totalCaRayon = rayonProds.reduce((s, p) => s + (p.totalCa ?? 0), 0);
        const totalQtyRayon = rayonProds.reduce((s, p) => s + (p.totalQuantite ?? 0), 0);

        // --- 3. Percentiles dans le lot fournisseur ---
        const allCaValues = allProds.map(p => p.totalCa ?? 0);
        const allQtyValues = allProds.map(p => p.totalQuantite ?? 0);
        const allMargeValues = allProds.map(p => p.tauxMarge ?? 0);

        const pCa = computePercentile(target.totalCa ?? 0, allCaValues);
        const pQty = computePercentile(target.totalQuantite ?? 0, allQtyValues);
        const pMarge = computePercentile(target.tauxMarge ?? 0, allMargeValues);
        const pComposite = scoring.compositeScore; // Déjà 0-100

        // --- 4. Tops (seuils adaptatifs sur la distribution réelle) ---
        const top20CaThreshold = valueAtPercentile(allCaValues, 80);
        const top20QtyThreshold = valueAtPercentile(allQtyValues, 80);
        const isTop20Ca = (target.totalCa ?? 0) >= top20CaThreshold;
        const isTop20Qty = (target.totalQuantite ?? 0) >= top20QtyThreshold;

        // --- 5. Médiane du lot (pour les signaux) ---
        const medianComposite = computeMedian(
            allProds.map((_, i) => i) // Approximation : le ScoringEngine ne donne pas tous les composites
        );
        // On utilise directement le percentile composite pour isAboveMedian
        const isAboveMedianComposite = pComposite >= 50;

        // --- 6. Signaux Trafic / Marge (seuils P40/P60/P70 sur la distribution) ---
        const qty60 = valueAtPercentile(allQtyValues, 60);
        const qty40 = valueAtPercentile(allQtyValues, 40);
        const marge40 = valueAtPercentile(allMargeValues, 40);
        const marge70 = valueAtPercentile(allMargeValues, 70);
        const medianQty = computeMedian(allQtyValues);

        const isHighVolumeWithLowMargin =
            (target.totalQuantite ?? 0) >= qty60 &&
            (target.tauxMarge ?? 0) < marge40;

        const isMargePure =
            (target.tauxMarge ?? 0) >= marge70 &&
            (target.totalQuantite ?? 0) < medianQty;

        // --- 7. Quadrant (basé sur médiane QTÉ et médiane Marge du lot) ---
        const medianMarge = computeMedian(allMargeValues);
        const { quadrant, quadrantLabel, quadrantEmoji } = ContextProfiler.resolveQuadrant(
            target.totalQuantite ?? 0,
            target.tauxMarge ?? 0,
            medianQty,
            medianMarge
        );

        // --- 8. Gardes-fous (issus du ScoringEngine) ---
        const isProtected =
            scoring.decision.isRecent ||
            scoring.decision.isTop30Supplier ||
            scoring.decision.isLastProduct;

        let protectionReason = "";
        if (scoring.decision.isRecent) protectionReason = "Nouveauté (< 3 mois de données)";
        else if (scoring.decision.isTop30Supplier) protectionReason = "Top 30% CA Fournisseur";
        else if (scoring.decision.isLastProduct) protectionReason = "Dernière référence du fournisseur";

        // --- 9. Règle absolue : score brut < 20 ---
        const scoreCritique = (target.score ?? 0) < 20;

        return {
            codein: target.codein,
            libelle1: target.libelle1,
            libelleNiveau2: target.libelleNiveau2 ?? "Général",

            quadrant,
            quadrantLabel,
            quadrantEmoji,

            percentileCa: pCa,
            percentileQty: pQty,
            percentileMarge: pMarge,
            percentileComposite: pComposite,

            weightCaFournisseur:
                totalCaFournisseur > 0
                    ? Math.round(((target.totalCa ?? 0) / totalCaFournisseur) * 1000) / 10
                    : 0,
            weightQtyFournisseur:
                totalQtyFournisseur > 0
                    ? Math.round(((target.totalQuantite ?? 0) / totalQtyFournisseur) * 1000) / 10
                    : 0,
            weightCaRayon:
                totalCaRayon > 0
                    ? Math.round(((target.totalCa ?? 0) / totalCaRayon) * 1000) / 10
                    : 0,
            weightQtyRayon:
                totalQtyRayon > 0
                    ? Math.round(((target.totalQuantite ?? 0) / totalQtyRayon) * 1000) / 10
                    : 0,

            tauxMarge: target.tauxMarge ?? 0,
            inactivityMonths: target.inactivityMonths ?? 0,
            regularityScore: target.regularityScore ?? 0,

            lotSize: allProds.length,
            rayonSize: rayonProds.length,

            isAboveMedianComposite,
            isTop20Ca,
            isTop20Qty,
            isHighVolumeWithLowMargin,
            isMargePure,

            isProtected,
            protectionReason,

            scoreCritique,
        };
    }

    /** Résout le quadrant en fonction des médianes du lot. */
    private static resolveQuadrant(
        qty: number,
        marge: number,
        medianQty: number,
        medianMarge: number
    ): { quadrant: Quadrant; quadrantLabel: string; quadrantEmoji: string } {
        if (qty > medianQty && marge > medianMarge) {
            return { quadrant: "STAR", quadrantLabel: "Star (Vol élevé, Marge élevée)", quadrantEmoji: "⭐" };
        }
        if (qty > medianQty && marge <= medianMarge) {
            return { quadrant: "TRAFIC", quadrantLabel: "Générateur de Trafic (Vol élevé, Marge faible)", quadrantEmoji: "🚶" };
        }
        if (qty <= medianQty && marge > medianMarge) {
            return { quadrant: "MARGE", quadrantLabel: "Contributeur de Marge (Vol faible, Marge élevée)", quadrantEmoji: "💎" };
        }
        return { quadrant: "WATCH", quadrantLabel: "Sous-performant (Vol faible, Marge faible)", quadrantEmoji: "⚠️" };
    }
}
