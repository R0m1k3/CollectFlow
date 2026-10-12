//! Appels de l'interface vers le serveur hors routes REST classiques.
//!
//! - **Actions** — `POST /api/actions/{nom}`, corps = tableau JSON des arguments.
//!   Remplacent les « server actions » Next.js : l'interface garde les mêmes
//!   fonctions (`getUsers()`, `saveSnapshot(…)`…), devenues de simples appels
//!   HTTP (cf. `src/lib/rpc.ts`). Une erreur renvoie `{ error }` avec un statut
//!   4xx/5xx, que le client relève comme une exception.
//! - **Pages** — `GET /api/pages/{nom}?…` : les données qu'une page serveur
//!   Next.js calculait avant rendu (tableau de bord, hit-parade…), paramètres
//!   d'URL compris.
//!
//! Chaque module déclare les siennes via `actions()` / `pages()`.

use crate::auth::{session, Claims, UtilisateurCourant};
use crate::error::{AppError, AppResult};
use axum::extract::{Path, Query};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

/// Contexte d'un appel : jeton de session, paramètres d'URL, arguments.
#[derive(Clone, Default)]
pub struct Ctx {
    pub token: Option<Claims>,
    pub query: HashMap<String, String>,
    pub args: Vec<Value>,
}

impl Ctx {
    /// Utilisateur connecté (401 sinon).
    pub async fn session(&self) -> AppResult<UtilisateurCourant> {
        crate::auth::require_session(self.token.as_ref()).await
    }
    /// Administrateur connecté (401/403 sinon).
    pub async fn admin(&self) -> AppResult<UtilisateurCourant> {
        crate::auth::require_admin(self.token.as_ref()).await
    }
    /// Argument n° `i` désérialisé (`null` s'il est absent).
    pub fn arg<T: DeserializeOwned>(&self, i: usize) -> AppResult<T> {
        let v = self.args.get(i).cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| AppError::bad_request(format!("Argument {i} invalide : {e}")))
    }
    /// Argument brut n° `i`.
    pub fn raw(&self, i: usize) -> Value {
        self.args.get(i).cloned().unwrap_or(Value::Null)
    }
    /// Paramètre d'URL (page), vide → `None`.
    pub fn q(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(|s| s.as_str()).filter(|s| !s.is_empty())
    }
}

pub type Handler = fn(Ctx) -> BoxFuture<'static, AppResult<Value>>;

/// Sérialise un résultat en JSON.
pub fn json<T: Serialize>(v: T) -> AppResult<Value> {
    serde_json::to_value(v).map_err(|e| AppError::internal(e.to_string()))
}

/// Transforme une fonction `async fn(Ctx) -> AppResult<Value>` en [`Handler`].
#[macro_export]
macro_rules! handler {
    ($f:path) => {
        (|c: $crate::rpc::Ctx| -> ::futures::future::BoxFuture<'static, $crate::error::AppResult<::serde_json::Value>> {
            Box::pin($f(c))
        }) as $crate::rpc::Handler
    };
}

static ACTIONS: LazyLock<HashMap<&'static str, Handler>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    for (name, h) in crate::modules_actions() {
        if m.insert(name, h).is_some() {
            panic!("action en double : {name}");
        }
    }
    m
});

static PAGES: LazyLock<HashMap<&'static str, Handler>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    for (name, h) in crate::modules_pages() {
        if m.insert(name, h).is_some() {
            panic!("page en double : {name}");
        }
    }
    m
});

fn no_store(v: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}

async fn call_action(Path(name): Path<String>, headers: HeaderMap, body: Option<Json<Value>>) -> AppResult<Response> {
    let h = ACTIONS.get(name.as_str()).ok_or_else(|| AppError::not_found(format!("Action inconnue : {name}")))?;
    let args = match body.map(|b| b.0) {
        Some(Value::Array(a)) => a,
        Some(Value::Null) | None => vec![],
        Some(other) => vec![other],
    };
    let ctx = Ctx { token: session::from_headers(&headers), query: HashMap::new(), args };
    Ok(no_store(h(ctx).await?))
}

async fn call_page(Path(name): Path<String>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> AppResult<Response> {
    let h = PAGES.get(name.as_str()).ok_or_else(|| AppError::not_found(format!("Page inconnue : {name}")))?;
    let ctx = Ctx { token: session::from_headers(&headers), query, args: vec![] };
    Ok(no_store(h(ctx).await?))
}

pub fn router() -> Router {
    // Force la construction des registres au démarrage (doublons détectés tôt).
    LazyLock::force(&ACTIONS);
    LazyLock::force(&PAGES);
    Router::new()
        .route("/api/actions/{name}", post(call_action))
        .route("/api/pages/{name}", get(call_page))
}
