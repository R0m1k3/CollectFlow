//! Authentification : comptes, sessions, clés d'API.

pub mod api_key;
pub mod authz;
pub mod fallback;
pub mod password;
pub mod session;

pub use api_key::ApiAuth;
pub use authz::{require_admin, require_session, AdminUser, SessionUser, UtilisateurCourant};
pub use session::{Claims, Token};

use axum::extract::ConnectInfo;
use axum::http::{header, Extensions, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Mot de passe initial
// ---------------------------------------------------------------------------

/// Mot de passe d'un compte administrateur créé automatiquement :
/// `ADMIN_PASSWORD` s'il est défini, sinon aléatoire et écrit une seule fois
/// dans les journaux. Jamais « admin ».
pub fn mot_de_passe_initial(contexte: &str) -> String {
    if let Some(p) = std::env::var("ADMIN_PASSWORD").ok().filter(|p| !p.is_empty()) {
        tracing::warn!("[AUTH] {contexte} : mot de passe de ADMIN_PASSWORD.");
        return p;
    }
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    let p: String = (0..20).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
    tracing::warn!("[AUTH] {contexte} : mot de passe initial « {p} » (affiché une seule fois, à changer dans Paramètres).");
    p
}

// ---------------------------------------------------------------------------
// Amorçage du compte admin
// ---------------------------------------------------------------------------

/// `true` une fois l'amorçage réussi pour ce processus.
static AMORCE: Mutex<bool> = Mutex::const_new(false);

/// Prépare les comptes au premier démarrage, une seule fois par processus.
///
/// - Base joignable : crée la table `users` si besoin, puis un compte admin
///   (mot de passe `ADMIN_PASSWORD` ou aléatoire, dans les journaux)
///   **uniquement si la table est vide**. Les comptes de secours sont alors
///   désactivés pour de bon.
/// - Base injoignable et jamais atteinte (première installation) : s'assure
///   que le fichier de secours contient un administrateur ; on retentera la
///   base à la prochaine connexion.
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
            if !fallback::base_deja_initialisee() {
                fallback::assurer_admin_de_secours();
            }
            anyhow::bail!(e.message);
        }
    };
    if let Err(e) = sqlx::query("SELECT 1").execute(&pool).await {
        if !fallback::base_deja_initialisee() {
            fallback::assurer_admin_de_secours();
        }
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
    fallback::marquer_base_initialisee();
    let nb: i64 = sqlx::query_scalar("SELECT count(*) FROM users").fetch_one(&pool).await?;
    if nb > 0 {
        signaler_admin_par_defaut(&pool).await;
        return Ok(false);
    }
    let mot_de_passe = mot_de_passe_initial("table users vide : compte admin créé");
    let res = sqlx::query("INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') ON CONFLICT DO NOTHING")
        .bind(password::hash_password(&mot_de_passe))
        .execute(&pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Installation existante : avertit si le compte « admin » a toujours le mot de
/// passe « admin » des anciennes versions (sans le modifier).
async fn signaler_admin_par_defaut(pool: &sqlx::PgPool) {
    let hash: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE username = 'admin'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    if let Some(hash) = hash {
        let defaut = tokio::task::spawn_blocking(move || password::verify_password("admin", &hash)).await.unwrap_or(false);
        if defaut {
            tracing::error!("[AUTH] Le compte « admin » a toujours le mot de passe « admin » : changez-le tout de suite (Paramètres > Utilisateurs).");
        }
    }
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
        Err(_) if fallback::base_deja_initialisee() => {
            // La base a déjà fonctionné : une panne ne rouvre pas les comptes de secours.
            tracing::warn!("[AUTH] DB unreachable; fallback accounts disabled (database already initialised).");
            None
        }
        Err(_) => {
            // Base injoignable uniquement : un compte absent de la base ne doit
            // pas pouvoir se connecter avec le fichier de secours.
            tracing::warn!("[AUTH] DB unreachable, falling back to JSON (first-run setup).");
            fallback::assurer_admin_de_secours();
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

// ---------------------------------------------------------------------------
// Limitation des échecs de connexion
// ---------------------------------------------------------------------------

const FENETRE_ECHECS: Duration = Duration::from_secs(15 * 60);
/// Échecs tolérés par adresse IP et identifiant, puis par adresse IP seule.
const MAX_ECHECS_COMPTE: u32 = 10;
const MAX_ECHECS_IP: u32 = 50;

static ECHECS: LazyLock<parking_lot::Mutex<HashMap<String, (u32, Instant)>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Adresse du client : celle de la connexion, ou celle transmise par un relais
/// local (nginx) dans `X-Forwarded-For` (dernière entrée) ou `X-Real-IP`.
fn adresse_client(headers: &HeaderMap, extensions: &Extensions) -> String {
    let pair = extensions.get::<ConnectInfo<SocketAddr>>().map(|ConnectInfo(a)| a.ip());
    let derriere_relais = pair.is_none_or(|ip| match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private())
        }
    });
    let transmise = || {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .or_else(|| headers.get("x-real-ip").and_then(|v| v.to_str().ok()))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    if derriere_relais { transmise().or_else(|| pair.map(|ip| ip.to_string())) } else { pair.map(|ip| ip.to_string()) }
        .unwrap_or_else(|| "inconnue".into())
}

fn cles_echecs(ip: &str, username: &str) -> [(String, u32); 2] {
    [(format!("{ip}|{}", username.to_lowercase()), MAX_ECHECS_COMPTE), (format!("{ip}|*"), MAX_ECHECS_IP)]
}

fn trop_d_echecs(cles: &[(String, u32)]) -> bool {
    let echecs = ECHECS.lock();
    cles.iter().any(|(cle, max)| echecs.get(cle).is_some_and(|(n, depuis)| depuis.elapsed() < FENETRE_ECHECS && n >= max))
}

fn noter_echec(cles: &[(String, u32)]) {
    let mut echecs = ECHECS.lock();
    if echecs.len() > 10_000 {
        echecs.retain(|_, (_, depuis)| depuis.elapsed() < FENETRE_ECHECS);
    }
    for (cle, _) in cles {
        let e = echecs.entry(cle.clone()).or_insert((0, Instant::now()));
        if e.1.elapsed() >= FENETRE_ECHECS {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }
}

fn effacer_echecs(cle: &str) {
    ECHECS.lock().remove(cle);
}

#[derive(Deserialize)]
struct LoginBody {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
}

async fn login(headers: HeaderMap, extensions: Extensions, Json(body): Json<LoginBody>) -> Response {
    let cles = cles_echecs(&adresse_client(&headers, &extensions), body.username.trim());
    if trop_d_echecs(&cles) {
        tracing::warn!("[AUTH] Connexion refusée, trop d'échecs : {}", cles[0].0);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "Trop de tentatives de connexion. Réessayez dans quelques minutes." })),
        )
            .into_response();
    }
    let Some(user) = authorize(body.username.trim(), &body.password).await else {
        noter_echec(&cles);
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Utilisateur ou mot de passe incorrect." }))).into_response();
    };
    effacer_echecs(&cles[0].0);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echecs_limites_puis_effaces() {
        let cles = cles_echecs("203.0.113.9", "Test-Limite");
        for _ in 0..MAX_ECHECS_COMPTE {
            assert!(!trop_d_echecs(&cles));
            noter_echec(&cles);
        }
        assert!(trop_d_echecs(&cles));
        effacer_echecs(&cles[0].0);
        assert!(!trop_d_echecs(&cles));
    }

    #[test]
    fn adresse_derriere_un_relais_local() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.1, 203.0.113.7".parse().unwrap());
        let mut ext = Extensions::new();
        ext.insert(ConnectInfo(SocketAddr::from(([172, 18, 0, 2], 4000))));
        assert_eq!(adresse_client(&headers, &ext), "203.0.113.7");
        let mut ext = Extensions::new();
        ext.insert(ConnectInfo(SocketAddr::from(([198, 51, 100, 50], 4000))));
        assert_eq!(adresse_client(&headers, &ext), "198.51.100.50");
    }
}
