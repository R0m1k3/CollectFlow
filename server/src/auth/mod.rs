//! Authentification : comptes, sessions, clés d'API.

pub mod api_key;
pub mod authz;
pub mod fallback;
pub mod password;
pub mod session;

pub use api_key::{ApiAuth, AuthContext};
pub use authz::{require_admin, require_session, AdminUser, SessionUser, UtilisateurCourant};
pub use session::{Claims, Token};

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Amorçage du compte admin
// ---------------------------------------------------------------------------

/// `true` une fois l'amorçage réussi pour ce processus.
static AMORCE: Mutex<bool> = Mutex::const_new(false);

/// Prépare les comptes au premier démarrage, une seule fois par processus.
///
/// - Base joignable : crée la table `users` si besoin, puis admin/admin
///   **uniquement si la table est vide**.
/// - Base injoignable : s'assure que le fichier de secours contient un
///   administrateur ; on retentera la base à la prochaine connexion.
pub async fn ensure_admin_exists() -> bool {
    let mut done = AMORCE.lock().await;
    if *done {
        return false;
    }
    match amorcer().await {
        Ok(cree) => {
            *done = true;
            cree
        }
        Err(e) => {
            tracing::warn!("[AUTH] Database seeding failed (expected if DB not configured yet): {e:#}");
            false
        }
    }
}

async fn amorcer() -> anyhow::Result<bool> {
    let pool = match crate::db::pool() {
        Ok(p) => p,
        Err(e) => {
            fallback::assurer_admin_de_secours();
            anyhow::bail!(e.message);
        }
    };
    if let Err(e) = sqlx::query("SELECT 1").execute(&pool).await {
        fallback::assurer_admin_de_secours();
        return Err(e.into());
    }
    sqlx::raw_sql(
        r#"CREATE TABLE IF NOT EXISTS "users" (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT NOW()
        )"#,
    )
    .execute(&pool)
    .await?;
    let nb: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&pool).await?;
    if nb > 0 {
        return Ok(false);
    }
    tracing::info!("[AUTH] Table users vide : création du compte admin/admin.");
    let res = sqlx::query("INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') ON CONFLICT DO NOTHING")
        .bind(password::hash_password("admin"))
        .execute(&pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ---------------------------------------------------------------------------
// Connexion / déconnexion
// ---------------------------------------------------------------------------

struct CompteTrouve {
    id: String,
    username: String,
    password_hash: String,
    role: String,
}

/// Vérifie les identifiants. `None` si refusés.
async fn authorize(username: &str, password: &str) -> Option<CompteTrouve> {
    ensure_admin_exists().await;
    if username.is_empty() || password.is_empty() {
        return None;
    }
    tracing::info!("[AUTH] Checking user \"{username}\"...");

    let db_lookup = async {
        let pool = crate::db::pool().map_err(|e| anyhow::anyhow!(e.message))?;
        let row = sqlx::query("SELECT id, username, password_hash, role FROM users WHERE username = $1")
            .bind(username)
            .fetch_optional(&pool)
            .await?;
        anyhow::Ok(row.map(|r| CompteTrouve {
            id: r.try_get::<i32, _>("id").unwrap_or_default().to_string(),
            username: r.try_get("username").unwrap_or_default(),
            password_hash: r.try_get("password_hash").unwrap_or_default(),
            role: r.try_get("role").unwrap_or_else(|_| "user".into()),
        }))
    };

    let user = match db_lookup.await {
        Ok(u) => {
            tracing::info!("[AUTH] DB check: User found: {}", u.is_some());
            u
        }
        Err(_) => {
            // Base injoignable uniquement : un compte absent de la base ne doit
            // pas pouvoir se connecter avec le fichier de secours.
            tracing::warn!("[AUTH] DB unreachable, falling back to JSON.");
            fallback::get_fallback_users().into_iter().find(|u| u.username == username).map(|u| CompteTrouve {
                id: u.id,
                username: u.username,
                password_hash: u.password_hash,
                role: u.role,
            })
        }
    }?;

    let ok = password::verify_password(password, &user.password_hash);
    tracing::info!("[AUTH] Password valid for \"{username}\": {ok}");
    ok.then_some(user)
}

#[derive(Deserialize)]
struct LoginBody {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
}

async fn login(headers: HeaderMap, Json(body): Json<LoginBody>) -> Response {
    let Some(user) = authorize(body.username.trim(), &body.password).await else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Utilisateur ou mot de passe incorrect." }))).into_response();
    };
    let claims = Claims {
        id: user.id.clone(),
        name: user.username.clone(),
        role: user.role.clone(),
        exp: chrono::Utc::now().timestamp() + session::MAX_AGE_SECS,
    };
    (
        [(header::SET_COOKIE, session::set_cookie(&claims, &headers)), (header::CACHE_CONTROL, "no-store".into())],
        Json(json!({ "ok": true, "user": { "id": user.id, "name": user.username, "role": user.role } })),
    )
        .into_response()
}

async fn logout() -> Response {
    ([(header::SET_COOKIE, session::clear_cookie())], Json(json!({ "ok": true }))).into_response()
}

/// Session courante pour l'interface (`useSession`). Relue en base : un compte
/// supprimé n'a plus de session.
async fn current_session(Token(token): Token) -> Response {
    let user = match token.as_ref() {
        Some(_) => authz::require_session(token.as_ref()).await.ok(),
        None => None,
    };
    let body = match user {
        Some(u) => json!({ "user": { "id": u.id, "name": u.username, "role": u.role } }),
        None => json!({ "user": null }),
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

pub fn router() -> Router {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/session", get(current_session))
}
