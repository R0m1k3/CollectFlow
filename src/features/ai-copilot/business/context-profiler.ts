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

export interface ContextProfilerCache {
    allCaPerStoreSorted: number[];
    allQtyPerStoreSorted: number[];
    allMargeValuesSorted: number[];

    totalCaFournisseur: number;
    totalQtyFournisseur: number;

    top20CaThreshold: number;
    top20QtyThreshold: number;

    medianQtyPerStore: number;
    medianMarge: number;

    marge40: number;
    qty60PerStore: number;

    rayonStats: Map<string, { totalCa: number; totalQty: number; count: number }>;
}

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
     * Le produit appartient aux 30% les moins performants en CA et Quantité.
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

function computePercentileFromSorted(value: number, sortedDistribution: number[]): number {
    if (sortedDistribution.length <= 1) return 100;

    let first = -1;
    let last = -1;

    for (let i = 0; i < sortedDistribution.length; i++) {
        const current = sortedDistribution[i];
        if (Math.abs(current - value) < 0.00001) { // Floating point protection
            if (first === -1) first = i;
            last = i;
        } else if (current > value) {
            if (first === -1) return Math.round((i / Math.max(1, sortedDistribution.length - 1)) * 100);
            break;
        }
    }

    if (first !== -1) {
        const avgRank = (first + last) / 2;
        return Math.round((avgRank / (sortedDistribution.length - 1)) * 100);
    }

    return 100;
}

function computeMedianFromSorted(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function valueAtPercentileFromSorted(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
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

const getNormStoreCount = (p: ProductAnalysisInput) => Math.max(1, p.storeCount ?? 1);
const normCa = (p: ProductAnalysisInput) => (p.totalCa ?? 0) / getNormStoreCount(p);
const normQty = (p: ProductAnalysisInput) => (p.totalQuantite ?? 0) / getNormStoreCount(p);
const getWeightedCa = (p: ProductAnalysisInput) => p.weightedTotalCa ?? p.totalCa ?? 0;
const getWeightedQty = (p: ProductAnalysisInput) => p.weightedTotalQuantite ?? p.totalQuantite ?? 0;

// ---------------------------------------------------------------------------
// Profiler principal
// ---------------------------------------------------------------------------

export class ContextProfiler {

    /**
     * Prépare un cache contextuel basé sur tous les produits pour éviter des tris 
     * répétés en mode "Bulk Analyze". Réduit la latence de manière dramatique (O(N) au lieu de O(N^2)).
     */
    static prepareCache(allProds: ProductAnalysisInput[]): ContextProfilerCache {
        const allCaPerStore = allProds.map(normCa);
        const allQtyPerStore = allProds.map(normQty);
        const allMargeValues = allProds.map(p => p.tauxMarge ?? 0);

        // On trie une seule et unique fois
        const allCaPerStoreSorted = [...allCaPerStore].sort((a, b) => a - b);
        const allQtyPerStoreSorted = [...allQtyPerStore].sort((a, b) => a - b);
        const allMargeValuesSorted = [...allMargeValues].sort((a, b) => a - b);

        const totalCaFournisseur = allProds.reduce((s, p) => s + getWeightedCa(p), 0);
        const totalQtyFournisseur = allProds.reduce((s, p) => s + getWeightedQty(p), 0);

        const rayonStats = new Map<string, { totalCa: number; totalQty: number; count: number }>();
        allProds.forEach(p => {
            const key = getRayonKey(p);
            if (!rayonStats.has(key)) rayonStats.set(key, { totalCa: 0, totalQty: 0, count: 0 });
            const s = rayonStats.get(key)!;
            s.totalCa += getWeightedCa(p);
            s.totalQty += getWeightedQty(p);
            s.count += 1;
        });

        return {
            allCaPerStoreSorted,
            allQtyPerStoreSorted,
            allMargeValuesSorted,
            totalCaFournisseur,
            totalQtyFournisseur,
            top20CaThreshold: valueAtPercentileFromSorted(allCaPerStoreSorted, 80),
            top20QtyThreshold: valueAtPercentileFromSorted(allQtyPerStoreSorted, 80),
            medianQtyPerStore: computeMedianFromSorted(allQtyPerStoreSorted),
            medianMarge: computeMedianFromSorted(allMargeValuesSorted),
            marge40: valueAtPercentileFromSorted(allMargeValuesSorted, 40),
            qty60PerStore: valueAtPercentileFromSorted(allQtyPerStoreSorted, 60),
            rayonStats,
        };
    }

    /**
     * Génère le profil contextuel d'un produit au sein de son lot fournisseur.
     */
    static buildProfile(
        target: ProductAnalysisInput,
        allProds: ProductAnalysisInput[],
        scoring: ScoringResult,
        cache?: ContextProfilerCache
    ): ProductContextProfile {
        if (allProds.length === 0) {
            throw new Error("[ContextProfiler] Le lot de produits est vide.");
        }

        // Utiliser le cache s'il est fourni (mode Bulk) pour éviter de recalculer, 
        // sinon le générer à la volée (mode single item)
        const ctx: ContextProfilerCache = cache ?? ContextProfiler.prepareCache(allProds);

        // ---------------------------------------------------------------------------
        // Normalisation par magasin — cœur de la v3
        // ---------------------------------------------------------------------------
        const targetStoreCount = getNormStoreCount(target);
        const targetCaPerStore = normCa(target);
        const targetQtyPerStore = normQty(target);

        // 1. Totaux fournisseur
        const { totalCaFournisseur, totalQtyFournisseur } = ctx;

        // 2. Totaux du rayon (Niveau 2 de nomenclature)
        const targetRayonKey = getRayonKey(target);
        const rayonStat = ctx.rayonStats.get(targetRayonKey) ?? { totalCa: 0, totalQty: 0, count: 0 };
        const totalCaRayon = rayonStat.totalCa;
        const totalQtyRayon = rayonStat.totalQty;
        const rayonSizeForSignals = rayonStat.count;

        // 3. Percentiles (0-100) — sur distribution PAR MAGASIN
        const pCa = computePercentileFromSorted(targetCaPerStore, ctx.allCaPerStoreSorted);
        const pQty = computePercentileFromSorted(targetQtyPerStore, ctx.allQtyPerStoreSorted);
        const pMarge = computePercentileFromSorted(target.tauxMarge ?? 0, ctx.allMargeValuesSorted);
        const pComposite = scoring.compositeScore;

        // 4. Tops 20%
        const isTop20Ca = targetCaPerStore >= ctx.top20CaThreshold;
        const isTop20Qty = targetQtyPerStore >= ctx.top20QtyThreshold;
        const isAboveMedianComposite = pComposite >= 50;

        // 5. Poids pondérés
        const weightCaFournisseur =
            totalCaFournisseur > 0
                ? Math.round((getWeightedCa(target) / totalCaFournisseur) * 1000) / 10
                : 0;
        const weightQtyFournisseur =
            totalQtyFournisseur > 0
                ? Math.round((getWeightedQty(target) / totalQtyFournisseur) * 1000) / 10
                : 0;

        const isLowContribution = pCa <= 30 && pQty <= 30 && pMarge <= 70;

        // 6. Signaux Trafic / Marge + Quadrant
        const signalsActive = rayonSizeForSignals >= MIN_RAYON_SIZE;

        let isHighVolumeWithLowMargin = false;
        let isMargePure = false;

        {
            if (signalsActive) {
                isHighVolumeWithLowMargin =
                    targetQtyPerStore >= ctx.qty60PerStore &&
                    (target.tauxMarge ?? 0) < ctx.marge40;
            }

            isMargePure =
                (target.tauxMarge ?? 0) > ctx.medianMarge &&
                targetQtyPerStore < ctx.medianQtyPerStore;
        }

        // 7. Quadrant
        const { quadrant, quadrantLabel, quadrantEmoji } = ContextProfiler.resolveQuadrant(
            targetQtyPerStore,
            target.tauxMarge ?? 0,
            ctx.medianQtyPerStore,
            ctx.medianMarge
        );

        // 8. Gardes-fous (signaux, pas des verdicts — Mary décide au final)
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
                    ? Math.round((getWeightedCa(target) / totalCaRayon) * 1000) / 10
                    : 0,
            weightQtyRayon:
                totalQtyRayon > 0
                    ? Math.round((getWeightedQty(target) / totalQtyRayon) * 1000) / 10
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
