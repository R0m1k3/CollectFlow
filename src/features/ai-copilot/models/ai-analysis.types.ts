export interface ProductAnalysisInput {
    codein: string;
    libelle1: string;
    totalCa: number;
    tauxMarge: number;
    totalQuantite: number;
    avgTotalQuantite?: number;
    sales12m: Record<string, number>;
    codeGamme: string | null;
}

export interface AnalysisResult {
    insight: string;
    codein: string;
    recommandation: "A" | "C" | "Z" | null;
}
