//! Authentification de l'API publique `/api/v1`.
//!
//! Deux voies : clé d'API (`X-API-Key` ou `Authorization: Bearer …`) pour les
//! appelants non-navigateur, ou session du navigateur (l'interface utilise les
//! mêmes routes). Échec → 401 JSON au format `/api/v1`, jamais de redirection.
//!
//! Seul le hachage SHA-256 des clés est stocké (table `api_keys`).

use crate::api_v1_response::{fail, ApiErrorCode};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;
use axum::response::Response;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use parking_lot::Mutex;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

const KEY_PREFIX: &str = "cf_";
const TRACE_USAGE: Duration = Duration::from_secs(60);
static DERNIERE_TRACE: LazyLock<Mutex<HashMap<i32, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
pub struct AuthContext {
    /// "api_key" | "session"
    pub via: &'static str,
    pub role: String,
    /// Nom de la clé, ou nom de l'utilisateur connecté.
    pub subject: String,
}

impl AuthContext {
    /// Restreint un endpoint aux appelants administrateurs.
    pub fn require_admin(&self) -> Result<(), Response> {
        if self.role != "admin" {
            return Err(fail(ApiErrorCode::Forbidden, "Rôle administrateur requis pour cette opération.", None));
        }
        Ok(())
    }
}

pub fn hash_api_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

pub struct GeneratedKey {
    pub key: String,
    pub key_hash: String,
    pub key_prefix: String,
}

/// Génère une clé : en clair (affichée une seule fois), son hachage, et un préfixe lisible.
pub fn generate_api_key() -> GeneratedKey {
    let mut buf = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut buf);
    let key = format!("{KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(buf));
    GeneratedKey { key_hash: hash_api_key(&key), key_prefix: key.chars().take(11).collect(), key }
}

fn hashes_equal(a: &str, b: &str) -> bool {
    match (hex::decode(a), hex::decode(b)) {
        (Ok(x), Ok(y)) => !x.is_empty() && x.len() == y.len() && bool::from(x.as_slice().ct_eq(y.as_slice())),
        _ => false,
    }
}

fn read_key(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    let authz = headers.get("authorization").and_then(|v| v.to_str().ok())?;
    let re = regex::Regex::new(r"(?i)^Bearer\s+(.+)$").unwrap();
    re.captures(authz).map(|c| c[1].trim().to_string())
}

/// Authentifie une requête `/api/v1`.
pub async fn require_api_auth(headers: &HeaderMap) -> Result<AuthContext, Response> {
    if let Some(presented) = read_key(headers) {
        let presented_hash = hash_api_key(&presented);
        let pool = crate::db::pool().map_err(|e| fail(ApiErrorCode::InternalError, e.message, None))?;
        let row = sqlx::query("SELECT id, name, role, key_hash, revoked_at FROM api_keys WHERE key_hash = $1 LIMIT 1")
            .bind(&presented_hash)
            .fetch_optional(&pool)
            .await
            .map_err(|e| fail(ApiErrorCode::InternalError, e.to_string(), None))?;
        let Some(row) = row else {
            return Err(fail(ApiErrorCode::Unauthorized, "Clé d'API invalide.", None));
        };
        let key_hash: String = row.try_get("key_hash").unwrap_or_default();
        if !hashes_equal(&key_hash, &presented_hash) {
            return Err(fail(ApiErrorCode::Unauthorized, "Clé d'API invalide.", None));
        }
        let revoked: Option<chrono::NaiveDateTime> = row.try_get("revoked_at").ok().flatten();
        if revoked.is_some() {
            return Err(fail(ApiErrorCode::Unauthorized, "Clé d'API révoquée.", None));
        }
        let id: i32 = row.try_get("id").unwrap_or_default();
        // Trace d'usage — jamais bloquante, au plus une écriture par minute et par clé.
        let tracer = {
            let mut m = DERNIERE_TRACE.lock();
            let due = m.get(&id).map(|t| t.elapsed() >= TRACE_USAGE).unwrap_or(true);
            if due {
                m.insert(id, Instant::now());
            }
            due
        };
        if tracer {
            tokio::spawn(async move {
                if let Err(e) = sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1").bind(id).execute(&pool).await {
                    tracing::error!("[api-auth] lastUsedAt KO: {}", crate::error::short(&e, 120));
                }
            });
        }
        return Ok(AuthContext {
            via: "api_key",
            role: row.try_get("role").unwrap_or_else(|_| "user".into()),
            subject: row.try_get("name").unwrap_or_default(),
        });
    }

    // Repli sur la session du navigateur.
    if let Some(c) = super::session::from_headers(headers) {
        return Ok(AuthContext { via: "session", role: c.role, subject: c.name });
    }

    Err(fail(
        ApiErrorCode::Unauthorized,
        "Authentification requise : fournissez un en-tête X-API-Key (ou Authorization: Bearer), ou connectez-vous.",
        None,
    ))
}

/// Extracteur pour les routes `/api/v1`.
pub struct ApiAuth(pub AuthContext);

impl<S: Send + Sync> FromRequestParts<S> for ApiAuth {
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(ApiAuth(require_api_auth(&parts.headers).await?))
    }
}
