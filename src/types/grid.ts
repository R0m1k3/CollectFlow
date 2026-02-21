/**
 * CollectFlow - Core Grid Types
 * Maps to the `ventes_produits` table via Drizzle ORM (camelCase).
 */

/** One row in the data grid, representing a product at a store for one period. */
export interface VenteProduit {
    id: number;
    codein: string;
    codeFournisseur: string | null;
    nomFournisseur: string | null;
    libelle1: string | null;
    gtin: string | null;
    reference: string | null;
    codeGamme: GammeCode | null;
    code3: string | null;
    libelle3: string | null;
    magasin: string;
    codeMagasin: string | null;
    annee: number | null;
    mois: number | null;
    periode: string;
    quantite: number | null;
    montantMvt: number | null;
    margeMvt: number | null;
}

/** A/B/C/Z status codes for product categories */
export type GammeCode = "A" | "B" | "C" | "Z";

/** A product row with its 12-month sales history and computed KPIs */
export interface ProductRow {
    codein: string;
    codeFournisseur: string;
    nomFournisseur: string;
    libelle1: string;
    gtin: string;
    reference: string;
    code3: string;
    libelle3: string;
    codeGamme: GammeCode | null;
    /** Draft gamme value before saving */
    codeGammeDraft: GammeCode | null;
    /** 12-month sales quantities, indexed by YYYYMM key */
    sales12m: Record<string, number>;
    totalQuantite: number;
    totalCa: number;
    totalMarge: number;
    tauxMarge: number;
    /** Combined performance score (0-10) */
    score: number;
    workingStores: string[];
    aiRecommendation?: string | null;
}

/** Summary bar totals for the currently visible/filtered rows */
export interface GridSummary {
    totalRows: number;
    totalQuantite: number;
    totalCa: number;
    totalMarge: number;
    tauxMargeGlobal: number;
}

/** Filters applied to the grid */
export interface GridFilters {
    magasin: string | null;
    codeFournisseur: string | null;
    code3: string | null;
    codeGamme: GammeCode | null;
    search: string;
}
