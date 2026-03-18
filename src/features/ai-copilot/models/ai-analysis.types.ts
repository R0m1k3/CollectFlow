import type { ProductContextProfile } from "../business/context-profiler";

export interface SiteMonthlyData {
    site: string;           // "Frouard" ou "Houdemont"
    mois: string;           // "YYYY-MM"
    ventes_qte: number;
    ventes_ca: number;
    marge: number;
    stock_fin_mois: number; // peut être négatif (validation tardive de commande)
    receptions_qte: number;
}

export interface ProductAnalysisInput {
    codein: string;
    libelle1: string;
    libelleNiveau2?: string;
    /**
     * Code de nomenclature au niveau 2 (4 premiers chiffres du code à 6 chiffres).
     * Utilisé pour calculer les poids rayon sur le bon périmètre (pas trop fin = niveau 3).
     * Correspond à `code2` dans ProductRow.
     */
    codeNomenclatureN2?: string;
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
    /** Contexte Fournisseur */
    codeFournisseur?: string;
    totalMagasins?: number;
    isLastProductOfSupplier?: boolean;
    /** Scoring metadata */
    scoring?: {
        compositeScore: number;
        decision: "A" | "Z";
        labelProfil: string;
        isTop30Supplier: boolean;
        isRecent: boolean;
        isLastProduct: boolean;
        threshold: number;
    };
    /** Optional context rules for the supplier */
    supplierContext?: string;
    /** SQL Server internal ID — pour fetch mensuel per-site */
    noid?: number;
    /** Données mensuelles per-site (ventes, stock, réceptions) */
    siteMonthlyData?: SiteMonthlyData[];
    /** Données stock & approvisionnement (API FF Nancy) */
    stockActuel?: number;
    stockTotal?: number;
    pcb?: number;
    commandesEnCours?: number;
    nbJoursDerniereVente?: number;
    derniereVente?: string;

    /**
     * Fiche de contexte enrichie générée par le ContextProfiler.
     * Transmise au prompt de l'IA pour une analyse multi-dimensionnelle.
     */
    contextProfile?: ProductContextProfile;
}

export interface AnalysisResult {
    insight: string;
    codein: string;
    recommandation: "A" | "B" | "C" | "D" | "Z" | null;
    scoring?: any; // On peut typer plus finement si nécessaire
}
