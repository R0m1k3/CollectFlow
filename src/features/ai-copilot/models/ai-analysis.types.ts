export interface ProductAnalysisInput {
    codein: string;
    libelle1: string;
    libelleNiveau2?: string;
    totalCa: number;
    tauxMarge: number;
    totalQuantite: number;
    weightedTotalQuantite?: number;
    weightedTotalCa?: number;
    avgTotalQuantite?: number;
    avgQtyRayon?: number;
    avgQtyFournisseur?: number;
    /** Poids relatifs (%) */
    shareCa?: number;
    shareMarge?: number;
    shareQty?: number;
    /** Référentiels */
    totalFournisseurCa?: number;
    storeCount: number;
    sales12m: Record<string, number>;
    codeGamme: string | null;
    score: number;
    regularityScore: number;
    /** Projection sur 12 mois si le produit est récent (Run Rate) */
    projectedTotalQuantite?: number;
    projectedTotalCa?: number;
    /** Analyse de saisonnalité */
    lastMonthWithSale?: string;
    inactivityMonths?: number;
}

export interface AnalysisResult {
    insight: string;
    codein: string;
    recommandation: "A" | "C" | "Z" | null;
}
