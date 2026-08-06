/**
 * CollectFlow — Types de la fiche produit (page /produits).
 */

import type {
    PgProduitDetailRow,
    PgProduitFournisseurRow,
    PgProduitSearchRow,
    PgProduitStockRow,
    PgGammeHistoryRow,
} from "@/lib/pg-ff-client";
import type { NetworkMetricCached } from "@/lib/qlik-network-cache";

/**
 * Une ligne de résultat de recherche produit.
 *
 * La recherche part de **Qlik** : chaque ligne est d'abord un produit du réseau
 * (identifié par son code centrale), éventuellement rapproché du catalogue FF
 * Nancy. `codein === null` = le réseau travaille ce produit, nous ne le
 * référençons pas.
 */
export interface ProduitRechercheRow {
    /** Dimension Qlik « Article Code » = `articles.artcentrale`. */
    codeCentrale: string;
    /** Libellé affiché : catalogue Nancy si référencé, sinon libellé réseau. */
    libelle: string;
    /** Libellé tel que Qlik le renvoie (vide si l'app n'expose pas de champ libellé). */
    libelleReseau: string;
    /** Fournisseur : catalogue Nancy prioritaire (nom réel), sinon champ Qlik. */
    fournisseur: string;
    /** `null` si le produit n'est pas au catalogue Nancy. */
    codein: string | null;
    nomenclature: string;
    /** Stock Nancy tous sites, `null` si produit non référencé. */
    stockLocal: number | null;

    // ─── Réseau Qlik, sur 12 mois glissants ─────────────────────────────────
    qteReseau: number;
    caReseau: number;
    nbMagasinsReseau: number;
    /** Part des magasins du réseau travaillant le produit (0..1). */
    tauxPresence: number;
    /** Quantité vendue par magasin qui travaille le produit. */
    qteParMagasinReseau: number;
    caParMagasinReseau: number;
    /** CA réseau / quantité réseau — panier moyen unitaire, `null` si pas de vente. */
    prixMoyenReseau: number | null;
    /** Taux de marge réseau en points de % (déjà normalisé), `null` si absent. */
    margePctReseau: number | null;
    /** Quantité réseau par mois `"YYYY-MM"` — alimente la sparkline de tendance. */
    qteByMonth: Record<string, number> | null;
    /**
     * Magasins vendeurs par mois `"YYYY-MM"`. La tendance porte sur la
     * qté/magasin : sans cette série, elle se rabat sur les quantités brutes.
     */
    nbMagByMonth: Record<string, number> | null;
    periode: string | null;
}

export interface ProduitRechercheResultat {
    rows: ProduitRechercheRow[];
    /** `qlik` = recherche nominale ; `db` = repli catalogue local (Qlik indisponible). */
    source: "qlik" | "db";
    /** Message d'erreur Qlik quand on a dû se rabattre sur la base locale. */
    qlikError: string | null;
    /** true si Qlik a renvoyé plus d'articles que la limite affichée. */
    tronque: boolean;
    /** Champ Qlik réellement interrogé (diagnostic). */
    champUtilise: string | null;
    /**
     * Produits du catalogue Nancy qui matchent le terme mais qu'aucun article
     * Qlik ne couvre (pas de code centrale, ou non vendus par le réseau).
     */
    locauxHorsReseau: PgProduitSearchRow[];
    dureeMs: number;
}

/** Les métriques d'un mois, pour un périmètre donné (total ou un site). */
export interface ProduitMois {
    /** Clé de mois FF, format "YYYYMM". */
    mois: string;
    qte: number;
    /** Issu de mntmvtttc — TTC malgré le nom historique `ca_ht`. */
    ca: number;
    marge: number;
    stockFinMois: number;
    qteRecue: number;
}

export interface ProduitTotaux {
    qte: number;
    ca: number;
    marge: number;
    /** Taux de marge en % (marge / CA × 100). */
    tauxMarge: number;
}

export interface ProduitFiche {
    /**
     * Identité catalogue FF Nancy — `null` pour un produit que le réseau
     * travaille mais que Nancy ne référence pas (fiche 100 % réseau).
     */
    detail: PgProduitDetailRow | null;
    /** Code centrale = clé Qlik. Toujours renseigné pour une fiche ouverte depuis la recherche. */
    codeCentrale: string;
    /** Libellé de l'article côté Qlik (peut être vide selon l'app Qlik). */
    libelleReseau: string;
    /** Fournisseur de l'article côté Qlik (peut être vide selon l'app Qlik). */
    fournisseurReseau: string;
    fournisseurs: PgProduitFournisseurRow[];
    stock: PgProduitStockRow[];
    commandesEnCours: number;
    gammes: PgGammeHistoryRow[];
    /** Les 12 clés de mois "YYYYMM", du plus ancien au plus récent. */
    months: string[];
    /** Cumul tous sites, par mois. */
    mensuelTotal: Record<string, ProduitMois>;
    /** site → mois → métriques. */
    mensuelParSite: Record<string, Record<string, ProduitMois>>;
    totaux: ProduitTotaux;
    totauxParSite: Record<string, ProduitTotaux>;
    /** Sites ayant vendu au moins une unité sur les 12 mois. */
    sitesActifs: string[];
    /** Métriques réseau Qlik, `null` si le produit n'est pas encore en cache. */
    reseau: NetworkMetricCached | null;
    /** Fenêtre analysée, pour l'affichage. */
    periode: { dateDebut: string; dateFin: string };
}
