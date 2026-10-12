// Les modules portés gardent quelques utilitaires et types de l'ancienne
// version sans appelant (déjà inutilisés côté TypeScript) : on ne les signale pas.
#![allow(dead_code)]

//! CollectFlow — serveur.
//!
//! Un binaire unique : API JSON (interface + `/api/v1` publique), accès à la
//! base PostgreSQL (tables de l'application et recopie FF Nancy), extraction
//! Qlik Sense, synchronisation nocturne, et service de l'interface compilée.

mod admin;
mod api_v1_response;
mod auth;
mod config;
mod db;
mod domain;
mod error;
mod ff;
mod ff_cache;
mod grid;
mod logcapture;
mod migrations;
mod produits;
mod qlik;
mod routes;
mod rpc;
mod spa;

use axum::extract::DefaultBodyLimit;
use axum::Router;
use rpc::Handler;
use tower_http::compression::CompressionLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// Toutes les actions déclarées par les modules.
pub fn modules_actions() -> Vec<(&'static str, Handler)> {
    [ff::actions(), qlik::actions(), grid::actions(), produits::actions(), admin::actions(), routes::actions()].concat()
}

/// Toutes les pages déclarées par les modules.
pub fn modules_pages() -> Vec<(&'static str, Handler)> {
    [ff::pages(), qlik::pages(), grid::pages(), produits::pages(), admin::pages(), routes::pages()].concat()
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,chromiumoxide=warn,tungstenite=warn,hyper=warn"));
    let fmt = tracing_subscriber::fmt::layer().with_target(false).with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout())).with_filter(filter);
    tracing_subscriber::registry().with(fmt).with(logcapture::CaptureLayer).init();
}

fn app() -> Router {
    Router::new()
        .merge(auth::router())
        .merge(rpc::router())
        .merge(ff::router())
        .merge(qlik::router())
        .merge(grid::router())
        .merge(produits::router())
        .merge(admin::router())
        .merge(routes::router())
        .merge(spa::router())
        // Les instantanés de la Grille peuvent peser plusieurs Mo.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(CompressionLayer::new())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Arrêt demandé.");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    tracing::info!("CollectFlow {} — démarrage", env!("CARGO_PKG_VERSION"));
    let _ = std::fs::create_dir_all(config::data_dir());

    migrations::run().await;
    tokio::spawn(async {
        auth::ensure_admin_exists().await;
    });
    admin::start_background_tasks();

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5643);
    let host = std::env::var("HOSTNAME").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| "0.0.0.0".into());
    let addr = format!("{host}:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        // HOSTNAME est parfois le nom du conteneur : on retombe sur toutes les interfaces.
        Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", port)).await?,
    };
    tracing::info!("Écoute sur http://{}", listener.local_addr()?);
    axum::serve(listener, app()).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}
