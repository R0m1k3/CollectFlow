//! Module `produits` — recherche produit (Qlik d'abord, base FF Nancy en repli)
//! et fiche produit.
//!
//! - [`search`] : recherche asynchrone (jobs en mémoire, cache 10 min) ;
//! - [`fiche`] : assemblage de la fiche produit (local + réseau) ;
//! - [`compare_reseau`] : normalisation du taux de marge réseau ;
//! - [`types`] : formes JSON partagées avec l'interface ;
//! - [`routes`] : `/api/produits/search`, `/api/produits/opportunites`, page `produit-fiche`.

pub mod compare_reseau;
pub mod fiche;
pub mod routes;
pub mod search;
pub mod types;

use crate::handler;
use crate::rpc::Handler;
use axum::routing::get;
use axum::Router;

/// Routes HTTP du module.
pub fn router() -> Router {
    Router::new()
        .route("/api/produits/search", get(routes::search_get).post(routes::search_post))
        .route("/api/produits/opportunites", get(routes::opportunites))
}

/// Actions (`POST /api/actions/{nom}`) du module.
pub fn actions() -> Vec<(&'static str, Handler)> {
    vec![]
}

/// Données de pages (`GET /api/pages/{nom}`) du module.
pub fn pages() -> Vec<(&'static str, Handler)> {
    vec![("produit-fiche", handler!(routes::page_produit_fiche))]
}
