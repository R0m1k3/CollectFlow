//! `/api/admin/sync/fournisseurs` — paramétrage par fournisseur de la synchro nocturne.

use crate::auth::AdminUser;
use crate::error::{AppError, AppResult};
use axum::http::StatusCode;
use axum::Json;
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFournisseurRow {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub actif_sql: bool,
    pub actif_qlik: bool,
    pub desactive_motif: Option<String>,
    pub dernier_sql_at: Option<String>,
    pub dernier_sql_statut: Option<String>,
    pub dernier_sql_lignes: Option<i32>,
    pub dernier_sql_erreur: Option<String>,
    pub dernier_sql_ms: Option<i32>,
    pub dernier_qlik_at: Option<String>,
    pub dernier_qlik_statut: Option<String>,
    pub dernier_qlik_codes: Option<i32>,
    pub dernier_qlik_erreur: Option<String>,
    pub dernier_qlik_ms: Option<i32>,
    pub updated_at: Option<String>,
}

fn ts(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<NaiveDateTime>, _>(col).ok().flatten().map(crate::db::iso)
}

pub fn from_row(r: &PgRow) -> SyncFournisseurRow {
    SyncFournisseurRow {
        code_fournisseur: r.try_get("code_fournisseur").unwrap_or_default(),
        nom_fournisseur: r.try_get("nom_fournisseur").ok().flatten(),
        actif_sql: r.try_get("actif_sql").unwrap_or(true),
        actif_qlik: r.try_get("actif_qlik").unwrap_or(true),
        desactive_motif: r.try_get("desactive_motif").ok().flatten(),
        dernier_sql_at: ts(r, "dernier_sql_at"),
        dernier_sql_statut: r.try_get("dernier_sql_statut").ok().flatten(),
        dernier_sql_lignes: r.try_get("dernier_sql_lignes").ok().flatten(),
        dernier_sql_erreur: r.try_get("dernier_sql_erreur").ok().flatten(),
        dernier_sql_ms: r.try_get("dernier_sql_ms").ok().flatten(),
        dernier_qlik_at: ts(r, "dernier_qlik_at"),
        dernier_qlik_statut: r.try_get("dernier_qlik_statut").ok().flatten(),
        dernier_qlik_codes: r.try_get("dernier_qlik_codes").ok().flatten(),
        dernier_qlik_erreur: r.try_get("dernier_qlik_erreur").ok().flatten(),
        dernier_qlik_ms: r.try_get("dernier_qlik_ms").ok().flatten(),
        updated_at: ts(r, "updated_at"),
    }
}

/// GET — la liste complète des fournisseurs paramétrés, avec l'état de leur
/// dernière synchronisation (quelques centaines de lignes : pas de pagination).
pub async fn get(_admin: AdminUser) -> AppResult<Json<Value>> {
    let pool = crate::db::pool()?;
    let rows = sqlx::query("SELECT * FROM sync_fournisseurs ORDER BY coalesce(nom_fournisseur, code_fournisseur) ASC")
        .fetch_all(&pool)
        .await?;
    let rows: Vec<SyncFournisseurRow> = rows.iter().map(from_row).collect();
    let resume = json!({
        "total": rows.len(),
        "actifsSql": rows.iter().filter(|r| r.actif_sql).count(),
        "actifsQlik": rows.iter().filter(|r| r.actif_qlik).count(),
        "desactivesAuto": rows.iter().filter(|r| r.desactive_motif.as_deref().map(|m| !m.is_empty()).unwrap_or(false)).count(),
        "enEchecSql": rows.iter().filter(|r| r.dernier_sql_statut.as_deref() == Some("echec")).count(),
        "enEchecQlik": rows.iter().filter(|r| r.dernier_qlik_statut.as_deref() == Some("echec")).count(),
        "jamaisSql": rows.iter().filter(|r| r.dernier_sql_at.is_none()).count(),
    });
    Ok(Json(json!({ "success": true, "fournisseurs": rows, "resume": resume })))
}

fn invalide(details: Vec<String>) -> AppError {
    AppError::with_body(StatusCode::BAD_REQUEST, json!({ "error": "Paramètres invalides", "details": details }))
}

/// PATCH — active ou désactive des fournisseurs, pour l'une ou l'autre source.
///
/// Réactiver lève le motif de désactivation automatique : un fournisseur remis
/// en service par l'admin ne doit pas garder un « aucun article » trompeur.
pub async fn patch(_admin: AdminUser, body: axum::body::Bytes) -> AppResult<Json<Value>> {
    let body: Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::with_body(StatusCode::BAD_REQUEST, json!({ "error": "Corps JSON invalide" })))?;
    let mut details = Vec::new();
    let codes: Vec<String> = match body.get("codes").and_then(|v| v.as_array()) {
        Some(a) => {
            let codes: Vec<String> = a.iter().filter_map(|v| v.as_str().map(String::from)).collect();
            if codes.len() != a.len() || codes.iter().any(|c| c.is_empty()) {
                details.push("Invalid input".to_string());
            }
            if codes.is_empty() {
                details.push("Too small: expected array to have >=1 items".to_string());
            }
            if codes.len() > 2000 {
                details.push("Too big: expected array to have <=2000 items".to_string());
            }
            codes
        }
        None => {
            details.push("Invalid input: expected array".to_string());
            vec![]
        }
    };
    let bool_opt = |k: &str, details: &mut Vec<String>| match body.get(k) {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            details.push("Invalid input: expected boolean".to_string());
            None
        }
    };
    let actif_sql = bool_opt("actifSql", &mut details);
    let actif_qlik = bool_opt("actifQlik", &mut details);
    if details.is_empty() && actif_sql.is_none() && actif_qlik.is_none() {
        details.push("Préciser au moins actifSql ou actifQlik".to_string());
    }
    if !details.is_empty() {
        return Err(invalide(details));
    }

    let reactivation = actif_sql == Some(true) || actif_qlik == Some(true);
    let pool = crate::db::pool()?;
    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new("UPDATE sync_fournisseurs SET updated_at = now()");
    if let Some(v) = actif_sql {
        qb.push(", actif_sql = ").push_bind(v);
    }
    if let Some(v) = actif_qlik {
        qb.push(", actif_qlik = ").push_bind(v);
    }
    if reactivation {
        qb.push(", desactive_motif = NULL");
    }
    qb.push(" WHERE code_fournisseur = ANY(").push_bind(codes).push(") RETURNING code_fournisseur");
    let rows = qb.build().fetch_all(&pool).await?;
    tracing::info!(
        "[api/admin/sync] {} fournisseur(s) mis à jour (sql={} qlik={})",
        rows.len(),
        actif_sql.map(|b| b.to_string()).unwrap_or_else(|| "undefined".into()),
        actif_qlik.map(|b| b.to_string()).unwrap_or_else(|| "undefined".into())
    );
    Ok(Json(json!({ "success": true, "misAJour": rows.len() })))
}
