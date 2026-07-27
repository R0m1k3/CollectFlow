/**
 * CollectFlow — Types de la fiche produit (page /produits).
 */

import type {
    PgProduitDetailRow,
    PgProduitFournisseurRow,
    PgProduitStockRow,
    PgGammeHistoryRow,
} from "@/lib/pg-ff-client";
import type { NetworkMetricCached } from "@/lib/qlik-network-cache";

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
    detail: PgProduitDetailRow;
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
