//! Module `admin` — comptes, clés d'API, Paramètres, synchronisation nocturne.

pub mod api_keys;
pub mod logs;
mod qlik_bridge;
pub mod settings;
pub mod sync_fournisseurs;
pub mod sync_settings;
pub mod users;

use crate::error::AppResult;
use crate::handler;
use crate::rpc::{json, Ctx, Handler};
use axum::routing::get;
use axum::Router;
use serde_json::{Map, Value};

/// Routes HTTP du module.
pub fn router() -> Router {
    Router::new()
        .route("/api/logs", get(logs::get_logs))
        .route("/api/admin/sync/fournisseurs", get(sync_fournisseurs::get).patch(sync_fournisseurs::patch))
}

async fn read_sync_settings_action(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    json(sync_settings::read_sync_settings())
}

async fn save_sync_settings_action(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let patch: Map<String, Value> = ctx.arg::<Option<Map<String, Value>>>(0)?.unwrap_or_default();
    json(sync_settings::save_sync_settings(&patch)?)
}

/// Actions (`POST /api/actions/{nom}`) du module.
pub fn actions() -> Vec<(&'static str, Handler)> {
    vec![
        ("getUsers", handler!(users::get_users)),
        ("createUser", handler!(users::create_user)),
        ("deleteUser", handler!(users::delete_user)),
        ("updatePassword", handler!(users::update_password)),
        ("getApiKeys", handler!(api_keys::get_api_keys)),
        ("createApiKey", handler!(api_keys::create_api_key)),
        ("revokeApiKey", handler!(api_keys::revoke_api_key)),
        ("deleteApiKey", handler!(api_keys::delete_api_key)),
        ("getParametresAffichables", handler!(settings::get_parametres_affichables)),
        ("testDatabaseConnection", handler!(settings::test_database_connection)),
        ("saveDatabaseSettings", handler!(settings::save_database_settings)),
        ("saveQlikSettings", handler!(settings::save_qlik_settings)),
        ("testQlikConnection", handler!(settings::test_qlik_connection)),
        ("saveFfApiSettings", handler!(settings::save_ff_api_settings)),
        ("testFfApiConnection", handler!(settings::test_ff_api_connection)),
        ("readSyncSettings", handler!(read_sync_settings_action)),
        ("saveSyncSettings", handler!(save_sync_settings_action)),
    ]
}

/// Données de pages (`GET /api/pages/{nom}`) du module.
pub fn pages() -> Vec<(&'static str, Handler)> {
    vec![]
}

/// Tâches de fond lancées au démarrage (minuteur de la synchro nocturne).
pub fn start_background_tasks() {}
