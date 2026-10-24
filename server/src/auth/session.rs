//! Jeton de session signé (cookie HttpOnly), remplaçant le JWT NextAuth.
//!
//! Contenu : identifiant, nom et rôle de l'utilisateur + expiration, encodés en
//! base64url et signés HMAC-SHA256 avec `AUTH_SECRET` (ou un secret aléatoire
//! conservé dans `data/.auth-secret`).

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::convert::Infallible;
use std::sync::LazyLock;

pub const COOKIE_NAME: &str = "cf_session";
/// Durée de vie d'une session : 30 jours (comme NextAuth).
pub const MAX_AGE_SECS: i64 = 30 * 24 * 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Identifiant (`users.id`, ou « 0 » pour le compte de secours).
    pub id: String,
    pub name: String,
    pub role: String,
    /// Expiration (secondes Unix).
    pub exp: i64,
}

/// Valeur d'exemple autrefois versionnée dans `docker-compose.yml` : publique,
/// donc refusée (le secret aléatoire de `data/.auth-secret` est utilisé à la place).
const SECRETS_PUBLIES: &[&str] = &["my-super-secret-key-that-should-be-changed-in-production"];

static SECRET: LazyLock<Vec<u8>> = LazyLock::new(|| {
    if let Ok(s) = std::env::var("AUTH_SECRET") {
        let s = s.trim();
        if SECRETS_PUBLIES.contains(&s) {
            tracing::error!(
                "[auth] AUTH_SECRET a une valeur publique (ancien docker-compose.yml) : ignorée, \
                 secret aléatoire de data/.auth-secret utilisé. Retirez AUTH_SECRET ou générez-en un (openssl rand -hex 32)."
            );
        } else if s.len() < 16 && !s.is_empty() {
            tracing::error!("[auth] AUTH_SECRET trop court (16 caractères minimum) : ignoré, secret aléatoire de data/.auth-secret utilisé.");
        } else if !s.is_empty() {
            return s.as_bytes().to_vec();
        }
    }
    let path = crate::config::data_dir().join(".auth-secret");
    if let Ok(s) = std::fs::read_to_string(&path) {
        if !s.trim().is_empty() {
            return s.trim().as_bytes().to_vec();
        }
    }
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let s = hex::encode(buf);
    let _ = std::fs::create_dir_all(crate::config::data_dir());
    if let Err(e) = std::fs::write(&path, &s) {
        tracing::warn!("[auth] secret de session non persisté ({e}) : les sessions ne survivront pas au redémarrage");
    }
    s.into_bytes()
});

/// Charge le secret de session au démarrage (avertissements visibles tout de suite).
pub fn initialiser_secret() {
    LazyLock::force(&SECRET);
}

fn sign(payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&SECRET).expect("hmac");
    mac.update(payload.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub fn encode(claims: &Claims) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default());
    let sig = sign(&payload);
    format!("{payload}.{sig}")
}

pub fn decode(token: &str) -> Option<Claims> {
    let (payload, sig) = token.split_once('.')?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&SECRET).ok()?;
    mac.update(payload.as_bytes());
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig).ok()?;
    mac.verify_slice(&sig_bytes).ok()?;
    let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if claims.exp < chrono::Utc::now().timestamp() {
        return None;
    }
    Some(claims)
}

/// Jeton lu dans l'en-tête `Cookie`, s'il est présent et valide.
pub fn from_headers(headers: &HeaderMap) -> Option<Claims> {
    for value in headers.get_all(axum::http::header::COOKIE) {
        let Ok(s) = value.to_str() else { continue };
        for part in s.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix(COOKIE_NAME).and_then(|r| r.strip_prefix('=')) {
                if let Some(c) = decode(v) {
                    return Some(c);
                }
            }
        }
    }
    None
}

fn is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// En-tête `Set-Cookie` qui ouvre la session.
pub fn set_cookie(claims: &Claims, req_headers: &HeaderMap) -> String {
    let secure = if is_https(req_headers) { "; Secure" } else { "" };
    format!("{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={MAX_AGE_SECS}{secure}", encode(claims))
}

/// En-tête `Set-Cookie` qui ferme la session.
pub fn clear_cookie() -> String {
    format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

/// Jeton de la requête (jamais de rejet : `None` si absent ou invalide).
#[derive(Debug, Clone)]
pub struct Token(pub Option<Claims>);

impl<S: Send + Sync> FromRequestParts<S> for Token {
    type Rejection = Infallible;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Token(from_headers(&parts.headers)))
    }
}
