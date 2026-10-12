//! Service de l'interface (SPA React compilée par Vite) et garde des pages.
//!
//! Les fichiers existants du répertoire statique sont servis tels quels. Toute
//! autre URL hors `/api` renvoie `index.html` (routage côté navigateur), après
//! les mêmes contrôles que l'ancien middleware Next.js :
//! - non connecté → `/login` ;
//! - connecté sur `/login` ou `/` → `/dashboard` ;
//! - `/settings` et `/admin/*` réservés aux administrateurs.

use crate::auth::session;
use axum::body::Body;
use axum::http::{header, HeaderValue, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Router;
use std::path::PathBuf;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

pub fn static_dir() -> PathBuf {
    std::env::var("STATIC_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("web"))
}

async fn page(req: Request<Body>) -> Response {
    let uri: Uri = req.uri().clone();
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "Route inconnue" }))).into_response();
    }

    let claims = session::from_headers(req.headers());
    let is_login = path == "/login";
    let is_public = is_login || path.starts_with("/public/");

    let user = match claims.as_ref() {
        Some(_) => crate::auth::require_session(claims.as_ref()).await.ok(),
        None => None,
    };

    match &user {
        None if !is_public => return Redirect::to("/login").into_response(),
        Some(_) if is_public || path == "/" => return Redirect::to("/dashboard").into_response(),
        Some(u) if (path.starts_with("/settings") || path.starts_with("/admin")) && !u.is_admin() => {
            return Redirect::to("/dashboard").into_response()
        }
        _ => {}
    }

    match tokio::fs::read(static_dir().join("index.html")).await {
        Ok(html) => (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            ],
            html,
        )
            .into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "Interface non compilée (index.html introuvable).").into_response(),
    }
}

pub fn router() -> Router {
    let dir = static_dir();
    let assets = Router::new()
        .nest_service("/assets", ServeDir::new(dir.join("assets")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ));
    let files = ServeDir::new(&dir)
        .append_index_html_on_directories(false)
        .fallback(tower::service_fn(|req: Request<Body>| async move { Ok::<_, std::convert::Infallible>(page(req).await) }));
    assets.fallback_service(files)
}
