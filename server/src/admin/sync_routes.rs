//! `/api/admin/sync` — réglages, état et pilotage de la synchronisation nocturne.

use super::sync_scheduler::{debut_fenetre, demander_arret, get_sync_scheduler_state, lancer_round, seed_sync_fournisseurs};
use super::sync_settings::{read_sync_settings, save_sync_settings};
use crate::auth::AdminUser;
use crate::error::{AppError, AppResult};
use axum::http::StatusCode;
use axum::Json;
use chrono::Local;
use serde_json::{json, Map, Value};

/// GET — réglages, état courant, et ouverture de fenêtre.
pub async fn get(_admin: AdminUser) -> AppResult<Json<Value>> {
    let settings = read_sync_settings();
    let maintenant = Local::now();
    let debut = debut_fenetre(&settings, maintenant);
    Ok(Json(json!({
        "success": true,
        "settings": settings,
        "state": get_sync_scheduler_state(),
        "dansLaFenetre": debut.is_some(),
        "fenetreDebutAt": debut.map(|d| crate::db::iso_utc(d.with_timezone(&chrono::Utc))),
        "maintenant": crate::db::iso_utc(maintenant.with_timezone(&chrono::Utc)),
    })))
}

fn corps_json(body: &[u8]) -> AppResult<Value> {
    serde_json::from_slice(body).map_err(|_| AppError::with_body(StatusCode::BAD_REQUEST, json!({ "error": "Corps JSON invalide" })))
}

/// Entier borné « coercé » comme `z.coerce.number().int().min().max()`.
fn coerce_int(v: &Value, min: i64, max: i64) -> Result<i64, String> {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    };
    let Some(n) = n.filter(|n| n.is_finite()) else {
        return Err("Invalid input: expected number, received NaN".into());
    };
    if n.fract() != 0.0 {
        return Err("Invalid input: expected int, received number".into());
    }
    let n = n as i64;
    if n < min {
        return Err(format!("Too small: expected number to be >={min}"));
    }
    if n > max {
        return Err(format!("Too big: expected number to be <={max}"));
    }
    Ok(n)
}

/// PATCH — met à jour les réglages.
pub async fn patch(_admin: AdminUser, body: axum::body::Bytes) -> AppResult<Json<Value>> {
    let body = corps_json(&body)?;
    let Some(obj) = body.as_object() else {
        return Err(AppError::with_body(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Paramètres invalides", "details": [": Invalid input: expected object"] }),
        ));
    };
    let mut patch = Map::new();
    let mut details = Vec::new();
    match obj.get("actif") {
        None => {}
        Some(Value::Bool(b)) => {
            patch.insert("actif".into(), Value::Bool(*b));
        }
        Some(_) => details.push("actif: Invalid input: expected boolean".to_string()),
    }
    for (k, min, max) in [("heureDebut", 0, 23), ("heureFin", 0, 23), ("qlikParNuit", 0, 200), ("sqlParQlik", 1, 500), ("qlikMinJours", 0, 365)] {
        if let Some(v) = obj.get(k) {
            match coerce_int(v, min, max) {
                Ok(n) => {
                    patch.insert(k.into(), Value::from(n));
                }
                Err(m) => details.push(format!("{k}: {m}")),
            }
        }
    }
    if !details.is_empty() {
        return Err(AppError::with_body(StatusCode::BAD_REQUEST, json!({ "error": "Paramètres invalides", "details": details })));
    }
    let settings = save_sync_settings(&patch)?;
    Ok(Json(json!({ "success": true, "settings": settings })))
}

/// POST — démarre un round manuellement, l'arrête, ou resynchronise la liste.
pub async fn post(_admin: AdminUser, body: axum::body::Bytes) -> AppResult<(StatusCode, Json<Value>)> {
    let body = corps_json(&body)?;
    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or_default();
    let forcer = match body.get("forcer") {
        None => Some(false),
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => None,
    };
    if !matches!(action, "start" | "stop" | "seed") || forcer.is_none() {
        return Err(AppError::with_body(StatusCode::BAD_REQUEST, json!({ "error": "Action inconnue (start, stop ou seed)" })));
    }
    match action {
        "seed" => {
            let n = seed_sync_fournisseurs().await?;
            Ok((StatusCode::OK, Json(json!({ "success": true, "fournisseurs": n }))))
        }
        "stop" => {
            demander_arret();
            Ok((StatusCode::OK, Json(json!({ "success": true, "state": get_sync_scheduler_state() }))))
        }
        _ => {
            let etat = get_sync_scheduler_state();
            if etat.en_cours {
                return Ok((StatusCode::CONFLICT, Json(json!({ "error": "Un round est déjà en cours.", "state": etat }))));
            }
            // Lancé en tâche de fond : le round dure des minutes, le client suit via GET.
            let forcer = forcer.unwrap_or(false);
            tokio::spawn(async move { lancer_round("manuel", forcer).await });
            // Laisse au round le temps de passer « en cours » avant de répondre.
            tokio::task::yield_now().await;
            Ok((StatusCode::OK, Json(json!({ "success": true, "state": get_sync_scheduler_state() }))))
        }
    }
}
