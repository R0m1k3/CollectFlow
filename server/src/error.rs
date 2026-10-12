//! Erreurs HTTP communes.
//!
//! Les routes « internes » (appelées par l'interface) répondent `{ "error": "…" }`
//! avec le statut adéquat ; l'API publique `/api/v1` a sa propre enveloppe
//! (`crate::api_v1_response`).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub message: String,
    /// Corps JSON complet à renvoyer à la place de `{ error }`.
    pub body: Option<Value>,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), body: None }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
    /// Réponse au corps libre (ex. `{ success: false, error }` avec un statut 500).
    pub fn with_body(status: StatusCode, body: Value) -> Self {
        let message = body.get("error").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        Self { status, message, body: Some(body) }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status, self.message)
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = self.body.unwrap_or_else(|| json!({ "error": self.message }));
        (self.status, Json(body)).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        // Une AppError enveloppée dans anyhow garde son statut.
        match e.downcast::<AppError>() {
            Ok(app) => app,
            Err(e) => {
                tracing::error!("[error] {e:#}");
                Self::internal(format!("{e:#}"))
            }
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("[db] {e}");
        Self::internal(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::bad_request(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        Self::internal(e.to_string())
    }
}

/// Message d'une erreur quelconque tronqué à `n` caractères (pour les journaux).
pub fn short(e: &dyn std::fmt::Display, n: usize) -> String {
    let s = e.to_string();
    s.chars().take(n).collect()
}
