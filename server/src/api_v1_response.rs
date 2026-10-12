//! Enveloppe de réponse de l'API publique `/api/v1`.
//!
//! Une forme unique : `{ data, pagination?, meta }` en succès,
//! `{ error: { code, message, details? } }` en échec, avec de vrais statuts HTTP.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiErrorCode {
    Unauthorized,
    Forbidden,
    BadRequest,
    NotFound,
    /// Donnée pas encore calculée : 202, ce n'est pas un échec.
    NotReady,
    InternalError,
}

impl ApiErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::BadRequest => "bad_request",
            Self::NotFound => "not_found",
            Self::NotReady => "not_ready",
            Self::InternalError => "internal_error",
        }
    }
    pub fn status(self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::BadRequest => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::NotReady => StatusCode::ACCEPTED,
            Self::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pagination {
    pub page: i64,
    pub limit: i64,
    pub total: i64,
    pub total_pages: i64,
    /// `true` s'il reste des pages à lire.
    pub has_more: bool,
}

pub fn build_pagination(page: i64, limit: i64, total: i64) -> Pagination {
    let limit = limit.max(1);
    let total_pages = ((total as f64) / (limit as f64)).ceil().max(1.0) as i64;
    Pagination { page, limit, total, total_pages, has_more: page < total_pages }
}

/// Réponse de succès. `meta` porte la fraîcheur de la donnée (`computedAt`).
pub fn ok<T: Serialize>(data: T, pagination: Option<Pagination>, meta: Option<Map<String, Value>>) -> Response {
    let mut body = Map::new();
    body.insert("data".into(), serde_json::to_value(data).unwrap_or(Value::Null));
    if let Some(p) = pagination {
        body.insert("pagination".into(), serde_json::to_value(p).unwrap_or(Value::Null));
    }
    body.insert("meta".into(), Value::Object(meta.unwrap_or_default()));
    Json(Value::Object(body)).into_response()
}

/// Réponse d'erreur. `details` sert notamment aux erreurs de validation.
pub fn fail(code: ApiErrorCode, message: impl Into<String>, details: Option<Value>) -> Response {
    let mut err = json!({ "code": code.as_str(), "message": message.into() });
    if let Some(d) = details {
        err["details"] = d;
    }
    (code.status(), Json(json!({ "error": err }))).into_response()
}
