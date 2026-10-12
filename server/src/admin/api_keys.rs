//! Gestion des clés de l'API `/api/v1` (administrateurs) — port de `api-key-actions.ts`.
//!
//! La clé en clair n'existe qu'une fois : renvoyée par `createApiKey`, jamais
//! restituée ensuite (seul son hachage SHA-256 est stocké). Une clé révoquée
//! conserve sa ligne, pour garder la trace de son usage passé.

use crate::auth::api_key::generate_api_key;
use crate::error::AppResult;
use crate::rpc::{json, Ctx};
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{json as j, Value};
use sqlx::Row;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiKeyRow {
    id: i32,
    name: String,
    key_prefix: String,
    role: String,
    created_by: Option<String>,
    created_at: Option<String>,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
}

fn ts(r: &sqlx::postgres::PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<NaiveDateTime>, _>(col).ok().flatten().map(crate::db::iso)
}

/// Liste les clés. Jamais de secret — seulement le préfixe lisible.
pub async fn get_api_keys(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let pool = crate::db::pool()?;
    let rows = sqlx::query(
        "SELECT id, name, key_prefix, role, created_by, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC",
    )
    .fetch_all(&pool)
    .await?;
    let out: Vec<ApiKeyRow> = rows
        .iter()
        .map(|r| ApiKeyRow {
            id: r.try_get("id").unwrap_or_default(),
            name: r.try_get("name").unwrap_or_default(),
            key_prefix: r.try_get("key_prefix").unwrap_or_default(),
            role: r.try_get("role").unwrap_or_default(),
            created_by: r.try_get("created_by").ok().flatten(),
            created_at: ts(r, "created_at"),
            last_used_at: ts(r, "last_used_at"),
            revoked_at: ts(r, "revoked_at"),
        })
        .collect();
    json(out)
}

/// Crée une clé et renvoie sa valeur **en clair, une seule et unique fois**.
pub async fn create_api_key(ctx: Ctx) -> AppResult<Value> {
    let moi = ctx.admin().await?;
    let name: String = ctx.arg::<Option<String>>(0)?.unwrap_or_default();
    let role: String = ctx.arg::<Option<String>>(1)?.unwrap_or_else(|| "user".into());
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(j!({ "success": false, "error": "Le nom de la clé est obligatoire." }));
    }
    if trimmed.chars().count() > 100 {
        return Ok(j!({ "success": false, "error": "Nom trop long (100 caractères max)." }));
    }
    let k = generate_api_key();
    let pool = crate::db::pool()?;
    let created_by = Some(moi.username.clone()).filter(|s| !s.is_empty());
    match sqlx::query("INSERT INTO api_keys (name, key_prefix, key_hash, role, created_by) VALUES ($1, $2, $3, $4, $5)")
        .bind(trimmed)
        .bind(&k.key_prefix)
        .bind(&k.key_hash)
        .bind(&role)
        .bind(created_by)
        .execute(&pool)
        .await
    {
        Ok(_) => Ok(j!({ "success": true, "key": k.key, "keyPrefix": k.key_prefix })),
        Err(e) => {
            tracing::error!("[api-keys] création KO: {e}");
            Ok(j!({ "success": false, "error": "Erreur technique lors de la création de la clé." }))
        }
    }
}

/// Révoque une clé : refusée dès l'appel suivant, mais toujours listée.
pub async fn revoke_api_key(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let id: i64 = ctx.arg(0)?;
    let pool = crate::db::pool()?;
    match sqlx::query("UPDATE api_keys SET revoked_at = now() WHERE id = $1").bind(id as i32).execute(&pool).await {
        Ok(_) => Ok(j!({ "success": true })),
        Err(e) => {
            tracing::error!("[api-keys] révocation KO: {e}");
            Ok(j!({ "success": false, "error": "Erreur lors de la révocation." }))
        }
    }
}

/// Supprime définitivement une clé (nettoyage de la liste).
pub async fn delete_api_key(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let id: i64 = ctx.arg(0)?;
    let pool = crate::db::pool()?;
    match sqlx::query("DELETE FROM api_keys WHERE id = $1").bind(id as i32).execute(&pool).await {
        Ok(_) => Ok(j!({ "success": true })),
        Err(e) => {
            tracing::error!("[api-keys] suppression KO: {e}");
            Ok(j!({ "success": false, "error": "Erreur lors de la suppression." }))
        }
    }
}
