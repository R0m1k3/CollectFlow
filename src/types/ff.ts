/**
 * CollectFlow — Formes des données renvoyées par le serveur (pages et actions).
 *
 * Recopiées des anciens modules serveur Next.js (`lib/pg-ff-client.ts`,
 * `lib/qlik-network-cache.ts`, `lib/api-ff-client.ts`, `lib/gammes-a-valider.ts`)
 * lors du passage au serveur Rust : l'interface n'en garde que les types, le
 * serveur renvoie exactement ces formes JSON.
 */

// ─── Base FF (recopie PostgreSQL) ────────────────────────────────────────────

export interface DashboardSiteStats {
    site: string;
    ca_hier: number;
    ca_n1: number;
    tickets_hier: number;
    tickets_n1: number;
    qte_hier: number;
    marge_hier: number;
    lignes_hier: number;
}

export interface DashboardTopItem {
    codein: string;
    libelle1: string;
    ca: number;
    qte: number;
    marge: number;
    stock: number;
    fournisseur: string;
}

export interface DashboardSiteTop10 {
    site: string;
    ca: DashboardTopItem[];
    qte: DashboardTopItem[];
    marge: DashboardTopItem[];
}

/** CA d'une nomenclature dans un magasin, hier et le même jour N-1. */
export interface DashboardNomenclatureRow {
    code: string;
    libelle: string;
    site: string;
    ca: number;
    ca_n1: number;
}

export interface DashboardData {
    dateHier: string;
    dateN1: string;
    sites: DashboardSiteStats[];
    top10BySite: DashboardSiteTop10[];
    /** Lignes par magasin, dans l'ordre du classement ; `null` si la base n'a pas répondu. */
    topNomenclatures: DashboardNomenclatureRow[] | null;
}

export interface CaByFournisseurRow {
    code: string;
    nom: string;
    site: string;
    mois: string;
    ca_ttc: number;
}

export interface CaByNomenclatureRow {
    code: string;
    libelle: string;
    site: string;
    mois: string;
    ca_ttc: number;
}

export interface HitParadeRow {
    codein: string;
    libelle: string;
    /** Référence fournisseur de l'article (artfou1.reference du fournisseur principal). */
    reference: string;
    fournisseur: string;
    nomenclature_code: string;
    nomenclature: string;
    site: string;
    qte_vendue: number;
    ca_ttc: number;
    marge: number;
    stock292: number;
    stock579: number;
    stockTotal: number;
}

export interface PgStockNegatifRow {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
    stockdispo: number;
    dernierevente: string | null;
    derniereentree: string | null;
}

export interface PgStockSansVenteRow {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
    stock_actuel: number;
    derniere_entree: string | null;
}

export interface PgSansVente6MoisRow {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
    stock_actuel: number;
    derniere_vente: string | null;
    derniere_entree: string | null;
    jours_sans_vente: number | null;
}

export interface PgCommandeAutoRow {
    site: string;
    codefou: string;
    nomfou: string;
    franco: number;
    nb_articles: number;
    montant_cde: number;
    franco_atteint: boolean | null;
    ecart_franco: number;
}

/**
 * Une ligne de résultat de recherche produit. Volontairement **légère** :
 * aucune agrégation `mvtart` ici (le seq-scan du ILIKE domine déjà le coût).
 * Le détail lourd n'est calculé qu'à l'ouverture de la fiche.
 */
export interface PgProduitSearchRow {
    no_id: number;
    codein: string;
    code_centrale: string;
    libelle1: string;
    /** Nom du fournisseur principal (artfou1.preference = 1), sinon son code. */
    fournisseur: string;
    codefou: string;
    nomenclature_code: string;
    nomenclature: string;
    stock_total: number;
    /** true si le produit a déjà des métriques réseau Qlik en cache. */
    has_reseau: boolean;
    qte_reseau: number;
    nb_magasins_reseau: number;
}

/** Identité, prix et nomenclature d'un produit (une seule ligne). */
export interface PgProduitDetailRow {
    no_id: number;
    codein: string;
    code_centrale: string;
    libelle1: string;
    nom_no_id: number | null;
    gtin: string;
    reference: string;
    pcb: number | null;
    /** article_infosup.prix_vente_mini */
    pv_central: number | null;
    /** cube_pa.pa */
    pa: number | null;
    code3: string | null;
    libelle3: string | null;
    code2: string | null;
    libelle2: string | null;
    code1: string | null;
    libelle1nom: string | null;
}

/** Un fournisseur référencé pour l'article. */
export interface PgProduitFournisseurRow {
    codefou: string;
    nomfou: string;
    reference: string;
    pcb: number | null;
    /** true si artfou1.preference = 1 */
    principal: boolean;
}

/** Stock temps réel par site pour un article. */
export interface PgProduitStockRow {
    site: string;
    stockdispo: number;
    qte: number;
    valstock: number;
    prmp: number;
    dernierevente: string | null;
    dernierereception: string | null;
}

/** Une gamme affectée à l'article pour une saison donnée. */
export interface PgGammeHistoryRow {
    saison_no_id: number;
    saison_code: string | null;
    saison_libelle: string | null;
    gamme_code: string;
    gamme_libelle: string | null;
}

/** Un produit de la même famille, comparé local vs réseau. */
export interface PgOpportuniteRow {
    codein: string;
    libelle1: string;
    code_centrale: string;
    fournisseur: string;
    qte_reseau: number;
    nb_magasins_reseau: number;
    ca_reseau: number;
    ca_par_magasin_reseau: number;
    qte_locale: number;
    nb_sites_locaux: number;
    qte_reseau_par_magasin: number;
    qte_locale_par_magasin: number;
    /** Écart réseau − local, par magasin, sur 12 mois. Positif = opportunité. */
    ecart_par_magasin: number;
}

// ─── Réseau Qlik ─────────────────────────────────────────────────────────────

/** Les mesures réseau Qlik pour un produit sur un mois donné. */
export interface QlikMonthMetrics {
    /** Quantité vendue réseau — toujours présente. */
    qte: number;
    /** CA réseau du mois. */
    ca?: number;
    /** Nombre de magasins ayant vendu le produit ce mois-là. */
    nbMag?: number;
    /** CA moyen par magasin sur le mois (mesure Qlik brute). */
    caMag?: number;
    /** Taux de marge réseau du mois (ratio brut Qlik, ex 0.32 = 32%). */
    margePct?: number;
}

export interface NetworkMetricCached {
    caReseau: number;
    qteReseau: number;
    nbMagasinsReseau: number;
    caParMagasinReseau: number;
    margePctReseau: number;
    /** Quantité réseau par mois : { "YYYY-MM": qté } — null si non synchronisé avec dates. */
    qteByMonth: Record<string, number> | null;
    /**
     * Détail mensuel complet : { "YYYY-MM": { qte, ca, nbMag, caMag, margePct } }.
     * null pour les lignes synchronisées avant l'ajout de la colonne — l'UI
     * retombe alors sur `qteByMonth`.
     */
    metricsByMonth: Record<string, QlikMonthMetrics> | null;
    /** Période couverte par l'extraction (ex "2025-03_2026-02"). */
    periode: string | null;
    /** Libellé de l'article côté Qlik — `null` tant qu'aucune recherche produit ne l'a renseigné. */
    libelleReseau: string | null;
    /** Fournisseur de l'article côté Qlik, même origine que `libelleReseau`. */
    fournisseurReseau: string | null;
    fetchedAt: string | null;
}

// ─── API FF Nancy ────────────────────────────────────────────────────────────

export interface FfMensuelVentes {
    nb_passages: string;
    qte_vendue: string;   // négatif (ex: "-2.000")
    ca_ht: string;        // négatif (ex: "-26.6600")
    ca_ttc: string;
    marge: string;        // positif (ex: "12.7600")
    taux_marge: string;
}

export interface FfMensuelReceptions {
    nb_receptions: string;
    qte_recue: string;
}

export interface FfMensuelEntry {
    mois: string;              // "YYYY-MM"
    site: string;              // code site ("292", "579")
    stock_fin_mois: string;    // stock fin de mois
    prmp_fin_mois: string;     // PRMP fin de mois
    ventes: FfMensuelVentes | null;
    receptions: FfMensuelReceptions | null;
}

export interface FfSyncTable {
    nom: string;
    derniereSync: string;
    nbLignes?: number;
    /** "ok" ou état d'erreur renvoyé par la synchronisation. */
    statut?: string;
    erreur?: string | null;
}

export interface FfSyncStatus {
    lastSync: string;
    tables: FfSyncTable[];
}

// ─── Gammes proposées par l'API, à valider ───────────────────────────────────

export interface PropositionGamme {
    codein: string;
    /** Gamme proposée. */
    gamme: string;
    /** Gamme enregistrée au moment de la proposition. */
    gammePrecedente: string | null;
}

export interface GammeAValider extends PropositionGamme {
    auteur: string | null;
    /** Date ISO de la proposition. */
    proposeeLe: string;
}

