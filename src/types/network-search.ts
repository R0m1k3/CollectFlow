/**
 * CollectFlow — Types de la recherche réseau Qlik.
 *
 * Partagés entre la route `/api/qlik/search` et la page `/recherche-reseau`.
 */

/** Une ligne de résultat : métriques Qlik du réseau + enrichissement local FF Nancy. */
export interface NetworkSearchRow {
    codeCentrale: string;
    /** Libellé tel qu'il apparaît dans Qlik (seule source pour un produit non référencé). */
    libelle: string;
    fournisseur?: string;
    famille?: string;

    // ── Métriques réseau (Qlik, 12 mois glissants) ──
    caReseau: number;
    qteReseau: number;
    nbMagasinsReseau: number;
    caParMagasinReseau: number;
    /** Ratio brut Qlik (0.32 = 32 %). */
    margePctReseau: number;
    /** Quantité vendue réseau par mois : { "YYYY-MM": qté }. */
    qteByMonth: Record<string, number> | null;

    // ── Enrichissement catalogue local ──
    /** false = produit vendu par le réseau mais absent de notre catalogue. */
    chezMoi: boolean;
    codein?: string;
    libelleLocal?: string;
    codefou?: string;
    nomfou?: string;
    pa?: number;
    pvCentral?: number;
    stock292?: number;
    stock579?: number;
    stockTotal?: number;
}

export type NetworkSearchStatus = "idle" | "running" | "success" | "error";

/** État d'un job de recherche, tel que renvoyé par GET/POST /api/qlik/search. */
export interface NetworkSearchJobState {
    jobId: string | null;
    status: NetworkSearchStatus;
    query: string;
    /** "code" = recherche par code centrale, "label" = recherche plein texte. */
    mode?: "code" | "label";
    /** Nb de valeurs « Article » trouvées par Qlik avant construction du cube. */
    matchCount?: number;
    /** true = recherche trop large, refusée pour protéger le moteur Qlik. */
    tooMany?: boolean;
    /** Nb max de produits accepté par recherche (affiché dans le message « trop large »). */
    maxProducts?: number;
    periode?: string;
    results?: NetworkSearchRow[];
    startedAt?: string;
    finishedAt?: string;
    error?: string;
}
