/**
 * CollectFlow — Context Profiler (v3 — Normalisation multi-magasin)
 *
 * Génère une fiche de contexte normalisée et adaptative pour chaque produit
 * AVANT de le soumettre à l'IA.
 *
 * v3 — Correctifs :
 *  - Normalisation par `storeCount` : tous les calculs de percentile, poids
 *    et quadrant utilisent les valeurs PAR MAGASIN (CA/store, QTÉ/store).
 *    Cela évite qu'un produit en 2 magasins soit mécaniquement favorisé
 *    dans les comparaisons par rapport à un produit en 1 seul magasin.
 *  - Le profil expose caPerStore et qtyPerStore pour que Mary voie les
 *    deux dimensions : réeau brut ET performance par magasin.
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

    // Profil Quadrant (basé sur valeurs PAR MAGASIN pour comparaison équitable)
    quadrant: Quadrant;
    quadrantLabel: string;
    quadrantEmoji: string;

    // Nombre de magasins référençant le produit
    storeCount: number;

    // Valeurs brutes réseau
    totalCaRaw: number;
    totalQtyRaw: number;

    // Valeurs normalisées PAR MAGASIN (pour comparaisons justes)
    caPerStore: number;
    qtyPerStore: number;

    // Percentiles dans le lot fournisseur (0 = plus faible, 100 = meilleur)
    // Calculés sur les valeurs normalisées par magasin
    percentileCa: number;
    percentileQty: number;
    percentileMarge: number;
    percentileComposite: number;

    // Poids réels dans le lot fournisseur
    // Calculés sur les valeurs brutes réseau (représentativité réelle du chiffre)
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
    isTop20Ca: boolean;     // Top 20% sur valeur PAR MAGASIN
    isTop20Qty: boolean;    // Top 20% sur valeur PAR MAGASIN
    /**
     * Fort volume ET marge < P40 du lot → rôle de "locomotive".
     * Désactivé si rayonSize < MIN_RAYON_SIZE.
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
     */
    isLowContribution: boolean;

    // Gardes-fous (issus du ScoringEngine)
    isProtected: boolean;
    protectionReason: string;

    // Règle absolue
    scoreCritique: boolean;
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

        // ---------------------------------------------------------------------------
        // Normalisation par magasin — cœur de la v3
        // Raison : un produit en 2 magasins a mécaniquement 2x plus de CA/QTÉ
        // qu'un produit identique en 1 magasin. Sans normalisation, les percentiles
        // et le quadrant sont fausss par le réseau de distribution, pas la perf.
        // ---------------------------------------------------------------------------
        const getNormStoreCount = (p: ProductAnalysisInput) => Math.max(1, p.storeCount ?? 1);
        const normCa = (p: ProductAnalysisInput) => (p.totalCa ?? 0) / getNormStoreCount(p);
        const normQty = (p: ProductAnalysisInput) => (p.totalQuantite ?? 0) / getNormStoreCount(p);

        const targetStoreCount = getNormStoreCount(target);
        const targetCaPerStore = normCa(target);
        const targetQtyPerStore = normQty(target);

        // 1. Totaux fournisseur (valeurs brutes pour les poids de représentativité réseau)
        const totalCaFournisseur = allProds.reduce((s, p) => s + (p.totalCa ?? 0), 0);
        const totalQtyFournisseur = allProds.reduce((s, p) => s + (p.totalQuantite ?? 0), 0);

        // 2. Totaux du rayon (Niveau 2 de nomenclature)
        const targetRayonKey = getRayonKey(target);
        const rayonProds = allProds.filter(p => getRayonKey(p) === targetRayonKey);
        const totalCaRayon = rayonProds.reduce((s, p) => s + (p.totalCa ?? 0), 0);
        const totalQtyRayon = rayonProds.reduce((s, p) => s + (p.totalQuantite ?? 0), 0);

        // 3. Distributions normalisées (PAR MAGASIN) — pour les percentiles et le quadrant
        const allCaPerStore = allProds.map(normCa);
        const allQtyPerStore = allProds.map(normQty);
        const allMargeValues = allProds.map(p => p.tauxMarge ?? 0);

        const pCa = computePercentile(targetCaPerStore, allCaPerStore);
        const pQty = computePercentile(targetQtyPerStore, allQtyPerStore);
        const pMarge = computePercentile(target.tauxMarge ?? 0, allMargeValues);
        const pComposite = scoring.compositeScore;

        // 4. Tops 20% (sur valeurs PAR MAGASIN)
        const top20CaThreshold = valueAtPercentile(allCaPerStore, 80);
        const top20QtyThreshold = valueAtPercentile(allQtyPerStore, 80);
        const isTop20Ca = targetCaPerStore >= top20CaThreshold;
        const isTop20Qty = targetQtyPerStore >= top20QtyThreshold;
        const isAboveMedianComposite = pComposite >= 50;

        // 5. Poids bruts (valeurs réseau pour représentativité commerciale réelle)
        const weightCaFournisseur =
            totalCaFournisseur > 0
                ? Math.round(((target.totalCa ?? 0) / totalCaFournisseur) * 1000) / 10
                : 0;
        const weightQtyFournisseur =
            totalQtyFournisseur > 0
                ? Math.round(((target.totalQuantite ?? 0) / totalQtyFournisseur) * 1000) / 10
                : 0;

        const isLowContribution = weightCaFournisseur < 0.5 && weightQtyFournisseur < 0.5;

        // 6. Signaux Trafic / Marge (sur valeurs PAR MAGASIN)
        const rayonSizeForSignals = rayonProds.length;
        const signalsActive = rayonSizeForSignals >= MIN_RAYON_SIZE;

        let isHighVolumeWithLowMargin = false;
        let isMargePure = false;

        if (signalsActive) {
            const marge40 = valueAtPercentile(allMargeValues, 40);
            const marge70 = valueAtPercentile(allMargeValues, 70);
            const qty60PerStore = valueAtPercentile(allQtyPerStore, 60);
            const medianQtyPerStore = computeMedian(allQtyPerStore);

            isHighVolumeWithLowMargin =
                targetQtyPerStore >= qty60PerStore &&
                (target.tauxMarge ?? 0) < marge40;

            isMargePure =
                (target.tauxMarge ?? 0) >= marge70 &&
                targetQtyPerStore < medianQtyPerStore;
        }

        // 7. Quadrant (basé sur les médianes PAR MAGASIN)
        const medianQtyPerStore = computeMedian(allQtyPerStore);
        const medianMarge = computeMedian(allMargeValues);
        const { quadrant, quadrantLabel, quadrantEmoji } = ContextProfiler.resolveQuadrant(
            targetQtyPerStore,
            target.tauxMarge ?? 0,
            medianQtyPerStore,
            medianMarge
        );

        // 8. Gardes-fous
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

            quadrant, quadrantLabel, quadrantEmoji,

            storeCount: targetStoreCount,
            totalCaRaw: target.totalCa ?? 0,
            totalQtyRaw: target.totalQuantite ?? 0,
            caPerStore: targetCaPerStore,
            qtyPerStore: targetQtyPerStore,

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
