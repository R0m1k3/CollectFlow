//! Journaux serveur des jobs (liste + téléchargement).
//!
//! `GET /api/logs`            → liste des journaux disponibles (JSON)
//! `GET /api/logs?id=<jobId>` → le journal complet en pièce jointe (text/plain)
//!
//! Réservé aux admins : un journal d'extraction contient les diagnostics du
//! modèle Qlik et les codes articles manipulés (jamais de secret).

use crate::auth::AdminUser;
use crate::logcapture::{list_captures, read_capture};
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub struct LogsQuery {
    id: Option<String>,
}

pub async fn get_logs(_admin: AdminUser, Query(q): Query<LogsQuery>) -> Response {
    let Some(id) = q.id.filter(|s| !s.is_empty()) else {
        return Json(json!({ "success": true, "logs": list_captures() })).into_response();
    };
    let Some(contenu) = read_capture(&id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Journal introuvable ou expiré" }))).into_response();
    };
    // Nom de fichier assaini : l'id finit dans un en-tête HTTP.
    let nom: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || "_.-".contains(c) { c } else { '_' }).collect();
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{nom}.log\"")),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        contenu,
    )
        .into_response()
}
