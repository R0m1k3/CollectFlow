//! CollectFlow — Enrichissement des lignes servies par `/api/v1`
//! (port de `src/lib/api-enrich.ts`).
//!
//! L'instantané `grid_rows` fige la ligne au moment du calcul. Deux informations
//! doivent pourtant refléter l'état **courant** au moment de l'appel :
//!
//! 1. **Métriques réseau Qlik** — la table `qlik_network_metrics` est mise à jour par
//!    les synchronisations et les recherches réseau, indépendamment du calcul de la
//!    grille. On les relit donc à la lecture, et on les expose telles quelles quand
//!    elles existent (`network: null` sinon).
//!
//! 2. **Gamme serveur** — `codeGamme` peut être surchargée par un snapshot de session.
//!    L'API expose la gamme **non modifiée**, celle réellement présente en base,
//!    relue à chaque appel.
//!
//! Ce n'est pas un recalcul : des lectures indexées bornées au nombre de lignes.

use super::gammes_a_valider::gammes_a_valider_par_article;
use super::months;
use super::network_trend::{compute_network_trend, trend_label, Direction};
use super::types::ProductRow;
use crate::ff::pg::pg_get_gammes_by_codeins;
use crate::qlik::network_cache::{get_network_metrics_by_code_centrale, NetworkMetricCached};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Tendance réseau 12 mois, telle qu'affichée dans la colonne « Tendance » de la Grille.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductTrend {
    pub direction: Direction,
    /// Variation des 4 derniers mois vs les 4 premiers (0.23 = +23 %). `null` si aucune base.
    #[serde(serialize_with = "super::js::opt_num::serialize")]
    pub pct: Option<f64>,
    /// Libellé prêt à afficher : « Forte hausse », « Nouveau », « Stable »…
    pub label: &'static str,
    /// `true` = tendance calculée sur la quantité **par magasin vendeur**.
    pub sur_qte_par_magasin: bool,
    /// Aucune vente sur les 4 premiers mois, des ventes sur les 4 derniers.
    pub nouveau: bool,
    /// Nombre de mois de la série (12 quand elle est complète).
    pub months_used: usize,
}

/// Ligne enrichie : la ligne, puis la gamme serveur, la proposition en attente,
/// les métriques réseau et la tendance (ordre des clés du TS).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichedProductRow {
    #[serde(flatten)]
    pub row: ProductRow,
    /// Gamme telle qu'elle existe sur le serveur PostgreSQL — non modifiée.
    pub code_gamme_serveur: Option<String>,
    /// Gamme proposée par l'API et pas encore validée dans la Grille.
    pub gamme_a_valider: Option<String>,
    /// Métriques réseau Qlik en cache, ou `null` si le produit n'en a pas.
    pub network: Option<NetworkMetricCached>,
    /// Tendance réseau sur les 12 derniers mois, `null` sans série mensuelle.
    pub trend: Option<ProductTrend>,
}

/// Enrichit un lot de lignes. Les lectures sont indépendantes et lancées en
/// parallèle ; un échec de l'une n'empêche pas les autres (l'API reste servie, avec
/// la valeur de l'instantané en repli).
pub async fn enrich_rows(rows: Vec<ProductRow>) -> Vec<EnrichedProductRow> {
    if rows.is_empty() {
        return vec![];
    }
    let mut vus = BTreeSet::new();
    let codes_centraux: Vec<String> =
        rows.iter().filter_map(|r| r.code_centrale.clone()).filter(|c| !c.is_empty() && vus.insert(c.clone())).collect();
    let mut vus = BTreeSet::new();
    let codeins: Vec<String> = rows.iter().map(|r| r.codein.clone()).filter(|c| !c.is_empty() && vus.insert(c.clone())).collect();

    let (network, gammes, a_valider) = tokio::join!(
        async {
            if codes_centraux.is_empty() {
                return HashMap::new();
            }
            get_network_metrics_by_code_centrale(&codes_centraux).await.unwrap_or_else(|e| {
                tracing::error!("[api-enrich] métriques réseau KO: {}", crate::error::short(&e, 160));
                HashMap::new()
            })
        },
        async {
            if codeins.is_empty() {
                return HashMap::new();
            }
            pg_get_gammes_by_codeins(&codeins).await.unwrap_or_else(|e| {
                tracing::error!("[api-enrich] gammes serveur KO: {}", crate::error::short(&e, 160));
                HashMap::new()
            })
        },
        async {
            gammes_a_valider_par_article(&codeins).await.unwrap_or_else(|e| {
                tracing::error!("[api-enrich] gammes à valider KO: {}", crate::error::short(&e.message, 160));
                HashMap::new()
            })
        },
    );

    let aujourd_hui = months::today();
    rows.into_iter()
        .map(|mut row| {
            let metrics = row.code_centrale.as_deref().filter(|c| !c.is_empty()).and_then(|c| network.get(c)).cloned();
            // Gamme absente de la base = pas de gamme, et non « inconnue ».
            let gamme_serveur = gammes.get(&row.codein).cloned();
            let gamme_a_valider = a_valider.get(&format!("{}|{}", row.code_fournisseur, row.codein)).cloned();

            // `codeGammeInit` porte déjà la sémantique « état serveur » dans la Grille :
            // on la garde alignée pour que les deux champs ne divergent jamais.
            if !gammes.is_empty() {
                row.code_gamme_init = gamme_serveur.clone();
            }

            // Les colonnes réseau de la ligne datent du calcul : on les réaligne sur le
            // cache quand il a quelque chose à dire.
            if let Some(m) = &metrics {
                row.ca_reseau = Some(m.ca_reseau);
                row.qte_reseau = Some(m.qte_reseau);
                row.nb_magasins_reseau = Some(m.nb_magasins_reseau);
                row.ca_par_magasin_reseau = Some(m.ca_par_magasin_reseau);
                row.marge_pct_reseau = Some(m.marge_pct_reseau);
                row.qte_reseau_by_month = Some(m.qte_by_month.clone());
                row.network_fetched_at = m.fetched_at.clone();
            }

            // Tendance : mêmes entrées que la colonne « Tendance » de la Grille — la
            // série des quantités **et** celle du nombre de magasins vendeurs.
            let serie = row.qte_reseau_by_month.clone().flatten();
            let nb_mag_by_month: Option<BTreeMap<String, f64>> = metrics
                .as_ref()
                .and_then(|m| m.metrics_by_month.as_ref())
                .map(|d| d.iter().map(|(mois, v)| (mois.clone(), v.nb_mag.filter(|n| !n.is_nan()).unwrap_or(0.0))).collect());
            let t = compute_network_trend(serie.as_ref(), nb_mag_by_month.as_ref(), aujourd_hui);
            let trend = t.has_data.then(|| ProductTrend {
                direction: t.direction,
                pct: t.pct,
                label: trend_label(t.pct, t.nouveau),
                sur_qte_par_magasin: t.sur_qte_par_magasin,
                nouveau: t.nouveau,
                months_used: t.values.len(),
            });

            EnrichedProductRow { row, code_gamme_serveur: gamme_serveur, gamme_a_valider, network: metrics, trend }
        })
        .collect()
}
