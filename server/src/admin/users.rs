//! Gestion des comptes (administrateurs) — port de `user-actions.ts`.

use crate::auth::password::hash_password;
use crate::error::AppResult;
use crate::rpc::{json, Ctx};
use serde::Serialize;
use serde_json::{json as j, Value};
use sqlx::Row;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserRow {
    id: i32,
    username: String,
    role: String,
    created_at: Option<String>,
}

/// Tous les utilisateurs.
pub async fn get_users(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let pool = crate::db::pool()?;
    let rows = sqlx::query("SELECT id, username, role, created_at FROM users").fetch_all(&pool).await?;
    let users: Vec<UserRow> = rows
        .iter()
        .map(|r| UserRow {
            id: r.try_get("id").unwrap_or_default(),
            username: r.try_get("username").unwrap_or_default(),
            role: r.try_get("role").unwrap_or_default(),
            created_at: r.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten().map(crate::db::iso),
        })
        .collect();
    json(users)
}

/// Crée un utilisateur.
pub async fn create_user(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let username: String = ctx.arg(0)?;
    let password: String = ctx.arg(1)?;
    let role: Option<String> = ctx.arg(2)?;
    let role = role.unwrap_or_else(|| "user".into());
    let pool = crate::db::pool()?;
    match sqlx::query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)")
        .bind(&username)
        .bind(hash_password(&password))
        .bind(&role)
        .execute(&pool)
        .await
    {
        Ok(_) => Ok(j!({ "success": true })),
        Err(e) => {
            tracing::error!("CreateUser Error: {e}");
            Ok(j!({ "success": false, "error": "L'utilisateur existe déjà ou une erreur technique est survenue." }))
        }
    }
}

/// Supprime un utilisateur (jamais son propre compte).
pub async fn delete_user(ctx: Ctx) -> AppResult<Value> {
    let moi = ctx.admin().await?;
    let id: i64 = ctx.arg(0)?;
    if moi.id.parse::<i64>().ok() == Some(id) {
        return Ok(j!({ "success": false, "error": "Vous ne pouvez pas supprimer votre propre compte." }));
    }
    let pool = crate::db::pool()?;
    match sqlx::query("DELETE FROM users WHERE id = $1").bind(id as i32).execute(&pool).await {
        Ok(_) => {
            crate::auth::authz::invalider(&id.to_string());
            Ok(j!({ "success": true }))
        }
        Err(_) => Ok(j!({ "success": false, "error": "Erreur lors de la suppression." })),
    }
}

/// Change le mot de passe d'un utilisateur.
pub async fn update_password(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let id: i64 = ctx.arg(0)?;
    let new_password: String = ctx.arg(1)?;
    let pool = crate::db::pool()?;
    match sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(hash_password(&new_password))
        .bind(id as i32)
        .execute(&pool)
        .await
    {
        Ok(_) => Ok(j!({ "success": true })),
        Err(_) => Ok(j!({ "success": false, "error": "Erreur lors de la mise à jour du mot de passe." })),
    }
}
