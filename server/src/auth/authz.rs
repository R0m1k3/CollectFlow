//! Contrôle d'accès commun aux actions, routes et pages.
//!
//! Le jeton de session seul ne suffit pas : il reste valide jusqu'à son
//! expiration, même si le compte a été supprimé ou rétrogradé entre-temps. On
//! relit donc l'utilisateur dans `users` (cache court), et le rôle en base
//! l'emporte sur celui du jeton.
//!
//! Base injoignable : on se contente du jeton (mode dégradé), sans quoi le
//! compte de secours `data/users.json` ne pourrait plus rien faire — y compris
//! configurer la base.

use super::session::{from_headers, Claims};
use crate::error::AppError;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use parking_lot::Mutex;
use serde::Serialize;
use sqlx::Row;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

pub const MESSAGE_SESSION: &str = "Session expirée : reconnectez-vous.";
pub const MESSAGE_ADMIN: &str = "Action réservée aux administrateurs.";

const CACHE_TTL: Duration = Duration::from_secs(60);
const PAUSE_BASE_INJOIGNABLE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
pub struct UtilisateurCourant {
    pub id: String,
    pub username: String,
    pub role: String,
}

impl UtilisateurCourant {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
    /// Identifiant numérique (`users.id`), `None` pour le compte de secours.
    pub fn id_numerique(&self) -> Option<i32> {
        self.id.parse::<i32>().ok().filter(|v| *v > 0)
    }
}

#[derive(Clone)]
struct Fiche {
    exists: bool,
    role: String,
    username: String,
    at: Instant,
}

struct CacheState {
    fiches: HashMap<String, Fiche>,
    injoignable_depuis: Option<Instant>,
}

static CACHE: LazyLock<Mutex<CacheState>> =
    LazyLock::new(|| Mutex::new(CacheState { fiches: HashMap::new(), injoignable_depuis: None }));

/// Oublie la fiche d'un utilisateur (après modification de son compte).
pub fn invalider(id: &str) {
    CACHE.lock().fiches.remove(id);
}

/// Fiche de l'utilisateur en base, ou `None` si la base n'a pas pu répondre.
async fn lire_fiche(id: &str) -> Option<Fiche> {
    {
        let c = CACHE.lock();
        if let Some(f) = c.fiches.get(id) {
            if f.at.elapsed() < CACHE_TTL {
                return Some(f.clone());
            }
        }
        if c.injoignable_depuis.map(|t| t.elapsed() < PAUSE_BASE_INJOIGNABLE).unwrap_or(false) {
            return None;
        }
    }
    let id_num: i32 = if id.chars().all(|c| c.is_ascii_digit()) && !id.is_empty() {
        id.parse::<i32>().unwrap_or(-1)
    } else {
        -1
    };
    let res = async {
        let pool = crate::db::pool().map_err(|e| anyhow::anyhow!(e.message))?;
        let row = sqlx::query("SELECT username, role FROM users WHERE id = $1 LIMIT 1")
            .bind(id_num)
            .fetch_optional(&pool)
            .await?;
        anyhow::Ok(row)
    }
    .await;
    match res {
        Ok(row) => {
            let fiche = match row {
                Some(r) => Fiche {
                    exists: true,
                    username: r.try_get("username").unwrap_or_default(),
                    role: r.try_get("role").unwrap_or_default(),
                    at: Instant::now(),
                },
                None => Fiche { exists: false, username: String::new(), role: String::new(), at: Instant::now() },
            };
            CACHE.lock().fiches.insert(id.to_string(), fiche.clone());
            Some(fiche)
        }
        Err(e) => {
            CACHE.lock().injoignable_depuis = Some(Instant::now());
            tracing::warn!("[authz] Base injoignable, contrôle sur le seul jeton de session : {}", crate::error::short(&e, 200));
            None
        }
    }
}

/// Utilisateur connecté, relu en base. 401 sinon.
pub async fn require_session(token: Option<&Claims>) -> Result<UtilisateurCourant, AppError> {
    let jeton = token.ok_or_else(|| AppError::unauthorized(MESSAGE_SESSION))?;
    match lire_fiche(&jeton.id).await {
        None => Ok(UtilisateurCourant { id: jeton.id.clone(), username: jeton.name.clone(), role: jeton.role.clone() }),
        Some(f) if !f.exists => Err(AppError::unauthorized(MESSAGE_SESSION)),
        Some(f) => Ok(UtilisateurCourant { id: jeton.id.clone(), username: f.username, role: f.role }),
    }
}

/// Administrateur connecté. 401 ou 403 sinon.
pub async fn require_admin(token: Option<&Claims>) -> Result<UtilisateurCourant, AppError> {
    let u = require_session(token).await?;
    if !u.is_admin() {
        return Err(AppError::forbidden(MESSAGE_ADMIN));
    }
    Ok(u)
}

/// Extracteur : utilisateur connecté (sinon 401 JSON `{ error }`).
pub struct SessionUser(pub UtilisateurCourant);

impl<S: Send + Sync> FromRequestParts<S> for SessionUser {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let claims = from_headers(&parts.headers);
        Ok(SessionUser(require_session(claims.as_ref()).await?))
    }
}

/// Extracteur : administrateur connecté (sinon 401/403 JSON `{ error }`).
pub struct AdminUser(pub UtilisateurCourant);

impl<S: Send + Sync> FromRequestParts<S> for AdminUser {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let claims = from_headers(&parts.headers);
        Ok(AdminUser(require_admin(claims.as_ref()).await?))
    }
}
