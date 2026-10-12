//! Module `qlik` — intégration Qlik Sense : données réseau (~270 magasins).
//!
//! - [`client`] : configuration, types partagés (`NetworkMetric`…), session NTLM ;
//! - [`ntlm`] : messages NTLM identiques à `httpntlm` ;
//! - [`browser`] : Chromium partagé, file d'extraction unique, page pilotée en CDP ;
//! - [`playwright`] : extraction réseau 12 mois (script in-page `js/extraction.js`) ;
//! - [`search`] : recherche produit dans Qlik (script in-page `js/recherche.js`) ;
//! - [`date_range`], [`validation`] : logique pure (fenêtre, contrôles) ;
//! - [`network_cache`] : table `qlik_network_metrics` ;
//! - [`sync`] : route `/api/qlik/sync` (jobs asynchrones).

pub mod browser;
pub mod client;
pub mod date_range;
pub mod jsnum;
pub mod network_cache;
pub mod ntlm;
pub mod playwright;
pub mod search;
pub mod sync;
pub mod validation;

#[cfg(test)]
mod tests_navigateur;

// Points d'entrée pour les autres modules (grid, produits, admin…).
#[allow(unused_imports)]
pub use client::{get_qlik_config, make_xrfkey, qlik_ntlm_session, NetworkMetric, NetworkProduct, QlikConfig, QlikMonthMetrics, QlikSession};
#[allow(unused_imports)]
pub use date_range::{
    build_grid_network_qlik_date_filter, build_grid_network_qlik_date_filter_now, chunk_serials, env_months_back, get_month_ranges,
    iso_date_to_qlik_serial, qlik_serial_to_iso_date, QlikDateFilter, QLIK_MONTHS_BACK_DEFAULT, QLIK_MONTHS_BACK_MAX, QLIK_MONTHS_BACK_MIN,
};
#[allow(unused_imports)]
pub use network_cache::{get_network_metrics_by_code_centrale, upsert_network_metrics, NetworkMetricCached};
#[allow(unused_imports)]
pub use playwright::fetch_network_metrics_playwright;
#[allow(unused_imports)]
pub use search::{search_qlik_articles, QlikArticleMatch, QlikSearchOutcome, QLIK_SEARCH_MAX_RESULTS};
#[allow(unused_imports)]
pub use validation::{assainir_metrique, controler_extraction, ControleExtraction, OptionsControle};

use crate::rpc::Handler;
use axum::routing::get;
use axum::Router;

/// Routes HTTP du module.
pub fn router() -> Router {
    Router::new().route("/api/qlik/sync", get(sync::get).post(sync::post))
}

/// Actions (`POST /api/actions/{nom}`) du module.
pub fn actions() -> Vec<(&'static str, Handler)> {
    vec![]
}

/// Données de pages (`GET /api/pages/{nom}`) du module.
pub fn pages() -> Vec<(&'static str, Handler)> {
    vec![]
}
