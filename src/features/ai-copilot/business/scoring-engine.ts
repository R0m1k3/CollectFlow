import { ProductAnalysisInput } from "../models/ai-analysis.types";

export interface ScoringResult {
    compositeScore: number;
    percentiles: {
        ca: number;
        volume: number;
        marge: number;
    };
    scores: {
        profil: number;
        activite: number;
    };
    decision: {
        recommendation: "A" | "Z";
        threshold: number;
        isTop30Supplier: boolean;
        isLastProduct: boolean;
        isRecent: boolean;
        labelProfil: string;
    };
    metrics: {
        caNormalise: number;
        volNormalise: number;
    };
}

export class ScoringEngine {
    /**
     * Calcule le score et la décision pour un produit au sein de son rayon.
     */
    static analyzeRayon(targetProduct: ProductAnalysisInput, allProducts: ProductAnalysisInput[]): ScoringResult {
        // 1. Normalisation et Projection pour tous les produits du rayon
        const processedProducts = allProducts.map(p => this.preprocess(p));
        const target = this.preprocess(targetProduct);

        // 2. Calcul des Percentiles (Rangs / Nb produits)
        const pCa = this.calculatePercentile(target.caNormalise, processedProducts.map(p => p.caNormalise));
        const pVol = this.calculatePercentile(target.volNormalise, processedProducts.map(p => p.volNormalise));
        const pMarge = this.calculatePercentile(target.tauxMarge, processedProducts.map(p => p.tauxMarge));

        // 3. Score Profil (Quadrant vs Médianes)
        const medVol = this.calculateMedian(processedProducts.map(p => p.volNormalise));
        const medMarge = this.calculateMedian(processedProducts.map(p => p.tauxMarge));

        let scoreProfil = 0.2;
        let labelProfil = "Sous-performant ⚠️";

        if (target.volNormalise > medVol && target.tauxMarge > medMarge) {
            scoreProfil = 1.0;
            labelProfil = "Star ⭐";
        } else if (target.volNormalise <= medVol && target.tauxMarge > medMarge) {
            scoreProfil = 0.7;
            labelProfil = "Contributeur Marge 💎";
        } else if (target.volNormalise > medVol && target.tauxMarge <= medMarge) {
            scoreProfil = 0.7;
            labelProfil = "Générateur Trafic 🚶";
        }

        // 4. Score Activité (Inactivité corrigée saisonnalité)
        const rayonInactivityRate = processedProducts.filter(p => (p.inactivityMonths || 0) > 0).length / processedProducts.length;
        const isSaisonnierRayon = rayonInactivityRate > 0.40;

        let scoreActivite = 1.0;
        const inactif = target.inactivityMonths || 0;

        if (isSaisonnierRayon && inactif > 0) {
            scoreActivite = 0.8;
        } else if (inactif === 1) {
            scoreActivite = 0.6;
        } else if (inactif === 2) {
            scoreActivite = 0.3;
        } else if (inactif >= 3) {
            scoreActivite = 0.0;
        }

        // 5. Score Composite
        const compositeScore = (pCa * 0.35) + (pVol * 0.25) + (pMarge * 0.20) + (scoreProfil * 0.10) + (scoreActivite * 0.10);

        // 6. Décision (Moyenne - Sigma)
        const allScores = processedProducts.map(p => {
            return this.calculateQuickScore(p, processedProducts, medVol, medMarge, isSaisonnierRayon);
        });

        const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
        const variance = allScores.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / allScores.length;
        const stdDev = Math.sqrt(variance);
        const threshold = Math.max(0.1, mean - 1.0 * stdDev); // Seuil plancher à 10/100

        let recommendation: "A" | "Z" = compositeScore >= threshold ? "A" : "Z";

        // 7. Gardes-fous et Labels
        const isRecent = (target.regularityScore || 0) < 3;
        const isTop30Supplier = this.checkTop30Supplier(target, processedProducts, compositeScore);
        const isLastProduct = target.isLastProductOfSupplier || false;

        let finalLabel = labelProfil;
        if (isRecent) {
            recommendation = "A";
            finalLabel = "Nouveauté (Protégée)";
        } else if (isTop30Supplier) {
            recommendation = "A";
            finalLabel = `${labelProfil} / Leader Fournisseur (Protégé)`;
        } else if (isLastProduct) {
            recommendation = "A";
            finalLabel = "Dernière Réf Fournisseur (Protégée)";
        }

        // Règle d'exclusion absolue (Demande Utilisateur) : Aucun produit de note < 20 en Gamme A
        if (target.score !== undefined && target.score < 20) {
            recommendation = "Z";
            finalLabel = "Note Globale Critique (< 20)";
        }

        return {
            compositeScore: Math.round(compositeScore * 100),
            percentiles: { ca: pCa, volume: pVol, marge: pMarge },
            scores: { profil: scoreProfil, activite: scoreActivite },
            decision: {
                recommendation,
                threshold: Math.round(threshold * 100),
                isTop30Supplier,
                isLastProduct,
                isRecent,
                labelProfil: finalLabel
            },
            metrics: {
                caNormalise: target.caNormalise,
                volNormalise: target.volNormalise
            }
        };
    }

    /**
     * Normalise les KPIs d'un produit pour comparaison équitable.
     *
     * Utilise les valeurs pondérées (weightedTotalCa / weightedTotalQuantite)
     * qui projettent les produits 1-magasin sur une base réseau comparable
     * (×2 si 1 magasin, ×1 si 2 magasins). Cela évite de pénaliser un
     * produit vendu uniquement dans 1 magasin face à un produit vendu dans 2.
     *
     * Applique ensuite la projection Run Rate pour les produits récents
     * (\< 12 mois d'historique) afin de comparer sur une base annuelle.
     */
    private static preprocess(p: ProductAnalysisInput) {
        // Valeurs pondérées réseau — si absentes, fallback sur les brutes
        let caNorm = p.weightedTotalCa ?? p.totalCa ?? 0;
        let volNorm = p.weightedTotalQuantite ?? p.totalQuantite ?? 0;

        // Run Rate Projection (produits avec 3-11 mois d'historique)
        if ((p.regularityScore || 0) >= 3 && (p.regularityScore || 0) < 12) {
            caNorm = (caNorm / (p.regularityScore || 3)) * 12;
            volNorm = (volNorm / (p.regularityScore || 3)) * 12;
        }

        return { ...p, caNormalise: caNorm, volNormalise: volNorm };
    }

    private static calculatePercentile(value: number, distribution: number[]): number {
        if (distribution.length <= 1) return 1;
        const sorted = [...distribution].sort((a, b) => a - b);

        // Trouver tous les index de la valeur pour gérer les ex-aequos
        const first = sorted.indexOf(value);
        const last = sorted.lastIndexOf(value);

        if (first === -1) return 0;

        // Rang moyen
        const avgRank = (first + last) / 2;
        return avgRank / (distribution.length - 1);
    }

    private static calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Vérifie si le produit est dans le Top 30% CA de son lot fournisseur.
     *
     * IMPORTANT : La protection n'est accordée que si le compositeScore est
     * suffisamment solide (>= 30/100). Sans ce garde-fou, on protège des
     * produits "Top 30% CA" qui ont en réalité un score catastrophique —
     * par exemple parce que leur CA est gonflé par un seul mois exceptionnel
     * ou parce que le lot fournisseur est très petit.
     *
     * Le seuil de 30% s'applique sur les valeurs normalisées (projetées
     * sur 12 mois et pondérées par réseau) pour éviter qu'un produit
     * avec beaucoup de mois de présence soit défavorisé.
     */
    private static checkTop30Supplier(
        target: any,
        allProducts: any[],
        compositeScore: number
    ): boolean {
        // Condition minimale de performance — si le score composite est < 30,
        // la protection CA seule ne suffit pas à classer en A.
        if (compositeScore < 30) return false;

        // Tous les produits du lot sont du même fournisseur en pratique,
        // mais on garde le filtre pour être robuste.
        const supplierProds = allProducts.length > 0 ? allProducts : [];
        if (supplierProds.length === 0) return false;

        const sorted = [...supplierProds].sort((a, b) => b.caNormalise - a.caNormalise);
        const topCount = Math.ceil(supplierProds.length * 0.30);
        const topIds = sorted.slice(0, topCount).map((p) => p.codein);
        return topIds.includes(target.codein);
    }


    private static calculateQuickScore(p: any, rayon: any[], medVol: number, medMarge: number, isSaisonnier: boolean): number {
        const pCa = this.calculatePercentile(p.caNormalise, rayon.map(x => x.caNormalise));
        const pVol = this.calculatePercentile(p.volNormalise, rayon.map(x => x.volNormalise));
        const pMarge = this.calculatePercentile(p.tauxMarge, rayon.map(x => x.tauxMarge));

        let sProfil = 0.2;
        if (p.volNormalise > medVol && p.tauxMarge > medMarge) sProfil = 1.0;
        else if (p.volNormalise <= medVol && p.tauxMarge > medMarge) sProfil = 0.7;
        else if (p.volNormalise > medVol && p.tauxMarge <= medMarge) sProfil = 0.7;

        let sActivite = 1.0;
        const inactif = p.inactivityMonths || 0;
        if (isSaisonnier && inactif > 0) sActivite = 0.8;
        else if (inactif === 1) sActivite = 0.6;
        else if (inactif === 2) sActivite = 0.3;
        else if (inactif >= 3) sActivite = 0.0;

        return (pCa * 0.35) + (pVol * 0.25) + (pMarge * 0.20) + (sProfil * 0.10) + (sActivite * 0.10);
    }
}
