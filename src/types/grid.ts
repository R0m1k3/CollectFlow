/**
 * CollectFlow - Core Grid Types
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
    codeGammeInit: GammeCode | null;
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

/** A/B/C/Z status codes for product categories, but can be any string from DB (like 'Aucune') */
export type GammeCode = string;

/** A product row with its 12-month sales history and computed KPIs */
export interface ProductRow {
    codein: string;
    codeFournisseur: string;
    nomFournisseur: string;
    libelle1: string;
    gtin: string;
    reference: string;
    code1: string;
    libelleNiveau1: string;
    code2: string;
    libelleNiveau2: string;
    code3: string;
    libelle3: string;
    codeGamme: GammeCode | null;
    codeGammeInit: GammeCode | null;
    /** Draft gamme value before saving */
    codeGammeDraft: GammeCode | null;
    /** 12-month sales quantities, indexed by YYYYMM key */
    sales12m: Record<string, number>;
    /** End-of-month stock levels, indexed by YYYYMM key */
    stock12m: Record<string, number>;
    /** Monthly reception quantities, indexed by YYYYMM key */
    receptions12m: Record<string, number>;
    /** Per-store breakdown (site → YYYYMM → qty) — always present even in TOTAL mode */
    sales12mByStore?: Record<string, Record<string, number>>;
    /** Per-store stock breakdown (site → YYYYMM → stock fin de mois) */
    stock12mByStore?: Record<string, Record<string, number>>;
    /** Per-store reception breakdown (site → YYYYMM → qté reçue) */
    receptions12mByStore?: Record<string, Record<string, number>>;
    /** Per-store CA totals */
    caByStore?: Record<string, number>;
    /** Per-store quantity totals */
    quantiteByStore?: Record<string, number>;
    /** Per-store margin totals */
    margeByStore?: Record<string, number>;
    totalQuantite: number;
    totalCa: number;
    totalMarge: number;
    tauxMarge: number;
    /** Score de performance hybride (0-100) */
    score: number;
    workingStores: string[];
    /** Rotation normalisée : unités vendues / magasin / mois */
    unitsPerStorePerMonth?: number;
    /** CA normalisé : € / magasin / an */
    caPerStorePerYear?: number;
    /** Produit récent (≤ 3 mois de données) */
    isRecent?: boolean;
    /** Seul produit du fournisseur dans le lot */
    isLastProduct?: boolean;
    /** Top 30% CA du lot fournisseur */
    isTop30Supplier?: boolean;
    aiRecommendation?: string | null;
    /** SQL Server internal ID — nécessaire pour /api/articles/:noid/mensuel */
    noid?: number;
    /** Données stock & approvisionnement (API FF Nancy) */
    pcb?: number;                    // Conditionnement (pack size)
    prixAchat?: number;              // PA / PRMP
    prixVente?: number;              // PV central
    stockActuel?: number;            // Stock dispo agrégé tous sites
    stockTotal?: number;             // Qte en stock agrégé
    stockValeur?: number;            // Valeur stock agrégée
    pa?: number;                     // PRMP (alias prixAchat)
    derniereVente?: string;          // ISO date de dernière vente
    derniereLivraison?: string;      // ISO date de dernière réception
    nbJoursDerniereVente?: number;   // Nb jours sans vente
    commandesEnCours?: number;       // Qté en commande fournisseur
    /** Moyennes de comparaison pour l'IA */
    avgQtyFournisseur?: number;
    avgQtyRayon?: number;
    /** Poids relatifs (%) du produit chez le fournisseur */
    shareCa?: number;
    shareMarge?: number;
    shareQty?: number;
    /** Référentiels globaux */
    totalFournisseurCa?: number;
    /** Ranking réseau (classement global) */
    rankingCa?: number;
    rankingQte?: number;
    /** Ranking magasin */
    rankingMagCa?: number;
    rankingMagQte?: number;
    /** Nombre total de produits classés dans le réseau (produits avec ventes sur la période) */
    totalRankedProducts?: number;
}

/** Summary bar totals for the currently visible/filtered rows */
export interface GridSummary {
    totalProducts: number;
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
    code1: string | null;
    code2: string | null;
    code3: string | null;
    codeGamme: GammeCode | null;
    search: string;
}
