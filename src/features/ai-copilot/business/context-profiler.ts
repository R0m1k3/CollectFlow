/**
 * CollectFlow — Context Profiler (v2 — Anti sur-classement)
 *
 * Génère une fiche de contexte normalisée et adaptative pour chaque produit
 * AVANT de le soumettre à l'IA.
 *
 * v2 — Correctifs :
 *  - Ajout du signal `isLowContribution` (poids CA ET QTÉ < 0.5% du fournisseur)
 *  - Désactivation des signaux Trafic/Marge si rayonSize < MIN_RAYON_SIZE (évite
 *    les faux positifs dans les micro-rayons de 3-5 produits).
 *  - Le profiler ne prescrit plus de verdict : il produit des données brutes
 *    que le prompt de Mary interprète avec un guide de décision pondéré.
 */

import type { ProductAnalysisInput } from "../models/ai-analysis.types";
import type { ScoringResult } from "./scoring-engine";

// ---------------------------------------------------------------------------
// Constante : seuil minimal de produits dans un rayon pour activer les signaux
// Trafic/Marge. En dessous = statistiques non significatives.
// ---------------------------------------------------------------------------
const MIN_RAYON_SIZE = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Quadrant = "STAR" | "TRAFIC" | "MARGE" | "WATCH";

export interface ProductContextProfile {
    // Identité
    codein: string;
    libelle1: string;
    libelleNiveau2: string;

    // Profil Quadrant
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

    // Poids réels dans le rayon (Niveau 2 de nomenclature)
    weightCaRayon: number;
    weightQtyRayon: number;

    // Santé temporelle
    tauxMarge: number;
    inactivityMonths: number;
    regularityScore: number;

    // Contexte du lot
    lotSize: number;
    rayonSize: number;

    // Signaux positifs (calculés sur la distribution réelle)
    isAboveMedianComposite: boolean;
    isTop20Ca: boolean;
    isTop20Qty: boolean;
    /**
     * Fort volume ET marge < P40 du lot → rôle de "locomotive".
     * Désactivé si rayonSize < MIN_RAYON_SIZE (percentiles non significatifs).
     */
    isHighVolumeWithLowMargin: boolean;
    /**
     * Marge > P70 du lot même si volume faible → capital rentabilité.
     * Désactivé si rayonSize < MIN_RAYON_SIZE.
     */
    isMargePure: boolean;

    // Signal négatif fort
    /**
     * Le produit pèse moins de 0.5% du CA ET des QTÉ du fournisseur.
     * Même un quadrant TRAFIC ne justifie pas un A si ce signal est actif
     * et que le score est faible.
     */
    isLowContribution: boolean;

    // Gardes-fous (issus du ScoringEngine)
    isProtected: boolean;
    protectionReason: string;

    // Règle absolue
    scoreCritique: boolean; // score brut < 20
}

// ---------------------------------------------------------------------------
// Helpers statistiques (purs)
// ---------------------------------------------------------------------------

function computePercentile(value: number, distribution: number[]): number {
    if (distribution.length <= 1) return 100;
    const sorted = [...distribution].sort((a, b) => a - b);
    const first = sorted.indexOf(value);
    const last = sorted.lastIndexOf(value);
    if (first === -1) return 0;
    const avgRank = (first + last) / 2;
    return Math.round((avgRank / (sorted.length - 1)) * 100);
}

function computeMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function valueAtPercentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

/**
 * Extrait la clé de groupement pour le rayon au niveau 2 de nomenclature.
 * Priorité : `codeNomenclatureN2` (4 premiers chiffres) > extraction numérique
 * depuis libelleNiveau2 > valeur brute de libelleNiveau2.
 */
function getRayonKey(p: ProductAnalysisInput): string {
    if (p.codeNomenclatureN2) {
        return p.codeNomenclatureN2;
    }
    // Fallback : extraire les 4 premiers chiffres si le libellé commence par un code numérique
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
     */
    static buildProfile(
        target: ProductAnalysisInput,
        allProds: ProductAnalysisInput[],
        scoring: ScoringResult
    ): ProductContextProfile {
        if (allProds.length === 0) {
            throw new Error("[ContextProfiler] Le lot de produits est vide.");
        }

        // 1. Totaux fournisseur
        const totalCaFournisseur = allProds.reduce((s, p) => s + (p.totalCa ?? 0), 0);
        const totalQtyFournisseur = allProds.reduce((s, p) => s + (p.totalQuantite ?? 0), 0);

        // 2. Totaux du rayon (Niveau 2 de nomenclature = 4 premiers chiffres du code)
        const targetRayonKey = getRayonKey(target);
        const rayonProds = allProds.filter(p => getRayonKey(p) === targetRayonKey);
        const totalCaRayon = rayonProds.reduce((s, p) => s + (p.totalCa ?? 0), 0);
        const totalQtyRayon = rayonProds.reduce((s, p) => s + (p.totalQuantite ?? 0), 0);

        // 3. Percentiles dans le lot fournisseur
        const allCaValues = allProds.map(p => p.totalCa ?? 0);
        const allQtyValues = allProds.map(p => p.totalQuantite ?? 0);
        const allMargeValues = allProds.map(p => p.tauxMarge ?? 0);

        const pCa = computePercentile(target.totalCa ?? 0, allCaValues);
        const pQty = computePercentile(target.totalQuantite ?? 0, allQtyValues);
        const pMarge = computePercentile(target.tauxMarge ?? 0, allMargeValues);
        const pComposite = scoring.compositeScore;

        // 4. Tops adaptatifs
        const top20CaThreshold = valueAtPercentile(allCaValues, 80);
        const top20QtyThreshold = valueAtPercentile(allQtyValues, 80);
        const isTop20Ca = (target.totalCa ?? 0) >= top20CaThreshold;
        const isTop20Qty = (target.totalQuantite ?? 0) >= top20QtyThreshold;
        const isAboveMedianComposite = pComposite >= 50;

        // 5. Signal négatif fort : contribution insignifiante au fournisseur
        const weightCaFournisseur =
            totalCaFournisseur > 0
                ? Math.round(((target.totalCa ?? 0) / totalCaFournisseur) * 1000) / 10
                : 0;
        const weightQtyFournisseur =
            totalQtyFournisseur > 0
                ? Math.round(((target.totalQuantite ?? 0) / totalQtyFournisseur) * 1000) / 10
                : 0;

        // isLowContribution = vrai si le produit représente < 0.5% du CA ET < 0.5% des QTÉ
        const isLowContribution = weightCaFournisseur < 0.5 && weightQtyFournisseur < 0.5;

        // 6. Signaux Trafic / Marge — désactivés si rayon trop petit (bruit statistique)
        const rayonSizeForSignals = rayonProds.length;
        const signalsActive = rayonSizeForSignals >= MIN_RAYON_SIZE;

        let isHighVolumeWithLowMargin = false;
        let isMargePure = false;

        if (signalsActive) {
            const marge40 = valueAtPercentile(allMargeValues, 40);
            const marge70 = valueAtPercentile(allMargeValues, 70);
            const qty60 = valueAtPercentile(allQtyValues, 60);
            const medianQty = computeMedian(allQtyValues);

            isHighVolumeWithLowMargin =
                (target.totalQuantite ?? 0) >= qty60 &&
                (target.tauxMarge ?? 0) < marge40;

            isMargePure =
                (target.tauxMarge ?? 0) >= marge70 &&
                (target.totalQuantite ?? 0) < medianQty;
        }

        // 7. Quadrant (basé sur les médianes du lot fournisseur)
        const medianQty = computeMedian(allQtyValues);
        const medianMarge = computeMedian(allMargeValues);
        const { quadrant, quadrantLabel, quadrantEmoji } = ContextProfiler.resolveQuadrant(
            target.totalQuantite ?? 0,
            target.tauxMarge ?? 0,
            medianQty,
            medianMarge
        );

        // 8. Gardes-fous (issus du ScoringEngine)
        const isProtected =
            scoring.decision.isRecent ||
            scoring.decision.isTop30Supplier ||
            scoring.decision.isLastProduct;

        let protectionReason = "";
        if (scoring.decision.isRecent) protectionReason = "Nouveauté (< 3 mois de données)";
        else if (scoring.decision.isTop30Supplier) protectionReason = "Top 30% CA Fournisseur";
        else if (scoring.decision.isLastProduct) protectionReason = "Dernière référence du fournisseur";

        // 9. Règle absolue
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

            weightCaFournisseur,
            weightQtyFournisseur,
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
            rayonSize: rayonSizeForSignals,

            isAboveMedianComposite,
            isTop20Ca,
            isTop20Qty,
            isHighVolumeWithLowMargin,
            isMargePure,
            isLowContribution,

            isProtected,
            protectionReason,

            scoreCritique,
        };
    }

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
