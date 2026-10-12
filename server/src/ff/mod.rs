//! Module `ff` — données FF Nancy : base miroir PostgreSQL (`pg`), API REST
//! (`api`), lectures partagées en cache (`cache`), diagnostic de l'API
//! (`diagnostic`), routes, actions et données de pages.

pub mod actions;
pub mod api;
pub mod cache;
pub mod diagnostic;
pub mod js;
pub mod pages;
pub mod pg;
pub mod routes;

#[cfg(test)]
mod fixture_tests;

use crate::handler;
use crate::rpc::Handler;
use axum::routing::get;
use axum::Router;

/// Routes HTTP du module.
pub fn router() -> Router {
    Router::new()
        .route("/api/ff-status", get(routes::ff_status))
        .route("/api/diag", get(routes::diag))
        .route("/api/diag/stock-fournisseur", get(routes::diag_stock_fournisseur))
        .route("/api/test-db", get(routes::test_db))
        .route("/api/commandes-auto", get(routes::commandes_auto))
}

/// Actions (`POST /api/actions/{nom}`) du module.
pub fn actions() -> Vec<(&'static str, Handler)> {
    vec![
        ("getFournisseurs", handler!(actions::get_fournisseurs)),
        ("getMagasins", handler!(actions::get_magasins)),
        ("getFournisseursPourCadence", handler!(actions::get_fournisseurs_pour_cadence)),
        ("listCadences", handler!(actions::list_cadences)),
        ("upsertCadence", handler!(actions::upsert_cadence)),
        ("toggleCadence", handler!(actions::toggle_cadence)),
        ("removeCadence", handler!(actions::remove_cadence)),
    ]
}

/// Données de pages (`GET /api/pages/{nom}`) du module.
pub fn pages() -> Vec<(&'static str, Handler)> {
    vec![
        ("dashboard", handler!(pages::page_dashboard)),
        ("analytics", handler!(pages::page_analytics)),
        ("hit-parade", handler!(pages::page_hit_parade)),
        ("stock-negatif", handler!(pages::page_stock_negatif)),
        ("commandes-auto", handler!(pages::page_commandes_auto)),
        ("publicites", handler!(pages::page_publicites)),
    ]
}
