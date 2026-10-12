//! Module `admin` — à porter.

use crate::rpc::Handler;
use axum::Router;

/// Routes HTTP du module.
pub fn router() -> Router {
    Router::new()
}

/// Actions (`POST /api/actions/{nom}`) du module.
pub fn actions() -> Vec<(&'static str, Handler)> {
    vec![]
}

/// Données de pages (`GET /api/pages/{nom}`) du module.
pub fn pages() -> Vec<(&'static str, Handler)> {
    vec![]
}

/// Tâches de fond lancées au démarrage (minuteur de la synchro nocturne).
pub fn start_background_tasks() {}
