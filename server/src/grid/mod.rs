//! Module `grid` — grille d'assortiment.
//!
//! Phase 1 (ce qui ne dépend ni de la base FF ni de Qlik) :
//! - [`types`] : `ProductRow` et types associés (JSON identique au TS) ;
//! - [`store`] : instantané persisté `grid_rows` (lu par `/api/v1`) ;
//! - [`rows_cache`] : cache mémoire des lignes calculées (10 min) ;
//! - [`network_trend`], [`months`], [`store_patch`] : logique pure ;
//! - [`gammes_a_valider`], [`enregistrer`], [`snapshots`] : gammes et snapshots ;
//! - [`exports`] : exports Excel ; [`api_schemas`], [`api_v1`], [`openapi`] : API publique.
//!
//! Phase 2 : calcul de la grille (`getProductRows`), enrichissement `/api/v1`
//! (`api-enrich`), routes `/api/v1/grid`, `/products/*`, `/gammes`,
//! `/fournisseurs`, `/network/*` et `/api/grid/rows*`.

pub mod api_schemas;
pub mod api_v1;
pub mod enregistrer;
pub mod exports;
pub mod gammes;
pub mod gammes_a_valider;
pub mod js;
pub mod months;
pub mod network_trend;
pub mod openapi;
pub mod rows_cache;
pub mod session;
pub mod snapshots;
pub mod store;
pub mod store_patch;
pub mod types;
pub mod zod;

#[cfg(test)]
mod tests_db;

use crate::rpc::Handler;
use axum::routing::{get, post};
use axum::Router;

/// Routes HTTP du module.
pub fn router() -> Router {
    Router::new()
        .route("/api/export/excel", post(exports::export_excel))
        .route("/api/export/modified-gammes", post(exports::export_modified_gammes))
        .route("/api/v1/nomenclatures", get(api_v1::get_nomenclatures))
        .route("/api/v1/openapi.json", get(openapi::get_openapi))
}

/// Actions (`POST /api/actions/{nom}`) du module.
pub fn actions() -> Vec<(&'static str, Handler)> {
    [snapshots::actions(), enregistrer::actions()].concat()
}

/// Données de pages (`GET /api/pages/{nom}`) du module.
pub fn pages() -> Vec<(&'static str, Handler)> {
    vec![]
}
