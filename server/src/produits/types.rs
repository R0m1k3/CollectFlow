//! CollectFlow — Types de la fiche produit (page /produits) — port de
//! `src/features/produits/types.ts`.
//!
//! Les formes JSON doivent rester **identiques** à la copie client
//! (`src/features/produits/types.ts`) : noms de champs camelCase, `null`
//! explicites là où le TS déclare `T | null`.

use crate::ff::api::DateRange;
use crate::ff::pg::{PgGammeHistoryRow, PgProduitDetailRow, PgProduitFournisseurRow, PgProduitSearchRow, PgProduitStockRow};
use crate::qlik::jsnum;
use crate::qlik::NetworkMetricCached;
use serde::Serialize;
use std::collections::BTreeMap;

/// Une ligne de résultat de recherche produit.
///
/// La recherche part de **Qlik** : chaque ligne est d'abord un produit du réseau
/// (identifié par son code centrale), éventuellement rapproché du catalogue FF
/// Nancy. `codein === null` = le réseau travaille ce produit, nous ne le
/// référençons pas.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProduitRechercheRow {
    /// Dimension Qlik « Article Code » = `articles.artcentrale`.
    pub code_centrale: String,
    /// Libellé affiché : catalogue Nancy si référencé, sinon libellé réseau.
    pub libelle: String,
    /// Libellé tel que Qlik le renvoie (vide si l'app n'expose pas de champ libellé).
    pub libelle_reseau: String,
    /// Fournisseur : catalogue Nancy prioritaire (nom réel), sinon champ Qlik.
    pub fournisseur: String,
    /// `null` si le produit n'est pas au catalogue Nancy.
    pub codein: Option<String>,
    pub nomenclature: String,
    /// Stock Nancy tous sites, `null` si produit non référencé.
    #[serde(serialize_with = "jsnum::ser_opt")]
    pub stock_local: Option<f64>,

    // ─── Réseau Qlik, sur 12 mois glissants ─────────────────────────────────
    #[serde(serialize_with = "jsnum::ser")]
    pub qte_reseau: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub ca_reseau: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub nb_magasins_reseau: f64,
    /// Part des magasins du réseau travaillant le produit (0..1).
    #[serde(serialize_with = "jsnum::ser")]
    pub taux_presence: f64,
    /// Quantité vendue par magasin qui travaille le produit.
    #[serde(serialize_with = "jsnum::ser")]
    pub qte_par_magasin_reseau: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub ca_par_magasin_reseau: f64,
    /// CA réseau / quantité réseau — panier moyen unitaire, `null` si pas de vente.
    #[serde(serialize_with = "jsnum::ser_opt")]
    pub prix_moyen_reseau: Option<f64>,
    /// Taux de marge réseau en points de % (déjà normalisé), `null` si absent.
    #[serde(serialize_with = "jsnum::ser_opt")]
    pub marge_pct_reseau: Option<f64>,
    /// Quantité réseau par mois `"YYYY-MM"` — alimente la sparkline de tendance.
    #[serde(serialize_with = "jsnum::ser_map")]
    pub qte_by_month: Option<BTreeMap<String, f64>>,
    /// Magasins vendeurs par mois `"YYYY-MM"`. La tendance porte sur la
    /// qté/magasin : sans cette série, elle se rabat sur les quantités brutes.
    #[serde(serialize_with = "jsnum::ser_map")]
    pub nb_mag_by_month: Option<BTreeMap<String, f64>>,
    pub periode: Option<String>,
}

/// Source d'un résultat de recherche.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceRecherche {
    /// Recherche nominale.
    #[default]
    Qlik,
    /// Repli catalogue local (Qlik indisponible).
    Db,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProduitRechercheResultat {
    pub rows: Vec<ProduitRechercheRow>,
    /// `qlik` = recherche nominale ; `db` = repli catalogue local (Qlik indisponible).
    pub source: SourceRecherche,
    /// Message d'erreur Qlik quand on a dû se rabattre sur la base locale.
    pub qlik_error: Option<String>,
    /// true si Qlik a renvoyé plus d'articles que la limite affichée.
    pub tronque: bool,
    /// Champ Qlik réellement interrogé (diagnostic).
    pub champ_utilise: Option<String>,
    /// Produits du catalogue Nancy qui matchent le terme mais qu'aucun article
    /// Qlik ne couvre (pas de code centrale, ou non vendus par le réseau).
    pub locaux_hors_reseau: Vec<PgProduitSearchRow>,
    pub duree_ms: u64,
}

/// Les métriques d'un mois, pour un périmètre donné (total ou un site).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProduitMois {
    /// Clé de mois FF, format "YYYYMM".
    pub mois: String,
    #[serde(serialize_with = "jsnum::ser")]
    pub qte: f64,
    /// Issu de mntmvtttc — TTC malgré le nom historique `ca_ht`.
    #[serde(serialize_with = "jsnum::ser")]
    pub ca: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub marge: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub stock_fin_mois: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub qte_recue: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProduitTotaux {
    #[serde(serialize_with = "jsnum::ser")]
    pub qte: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub ca: f64,
    #[serde(serialize_with = "jsnum::ser")]
    pub marge: f64,
    /// Taux de marge en % (marge / CA × 100).
    #[serde(serialize_with = "jsnum::ser")]
    pub taux_marge: f64,
}

/// Série mensuelle d'un périmètre : mois "YYYYMM" → métriques.
///
/// `BTreeMap` : les clés "YYYYMM" sont des indices de tableau pour JS, qui les
/// énumère par ordre croissant — même ordre que le tri lexicographique ici.
pub type SerieMensuelle = BTreeMap<String, ProduitMois>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProduitFiche {
    /// Identité catalogue FF Nancy — `null` pour un produit que le réseau
    /// travaille mais que Nancy ne référence pas (fiche 100 % réseau).
    pub detail: Option<PgProduitDetailRow>,
    /// Code centrale = clé Qlik. Toujours renseigné pour une fiche ouverte depuis la recherche.
    pub code_centrale: String,
    /// Libellé de l'article côté Qlik (peut être vide selon l'app Qlik).
    pub libelle_reseau: String,
    /// Fournisseur de l'article côté Qlik (peut être vide selon l'app Qlik).
    pub fournisseur_reseau: String,
    pub fournisseurs: Vec<PgProduitFournisseurRow>,
    pub stock: Vec<PgProduitStockRow>,
    #[serde(serialize_with = "jsnum::ser")]
    pub commandes_en_cours: f64,
    pub gammes: Vec<PgGammeHistoryRow>,
    /// Les 12 clés de mois "YYYYMM", du plus ancien au plus récent.
    pub months: Vec<String>,
    /// Cumul tous sites, par mois.
    pub mensuel_total: SerieMensuelle,
    /// site → mois → métriques.
    pub mensuel_par_site: BTreeMap<String, SerieMensuelle>,
    pub totaux: ProduitTotaux,
    pub totaux_par_site: BTreeMap<String, ProduitTotaux>,
    /// Sites ayant vendu au moins une unité sur les 12 mois.
    pub sites_actifs: Vec<String>,
    /// Métriques réseau Qlik, `null` si le produit n'est pas encore en cache.
    pub reseau: Option<NetworkMetricCached>,
    /// Fenêtre analysée, pour l'affichage.
    pub periode: DateRange,
}
