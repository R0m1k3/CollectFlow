//! Comptes de secours `data/users.json`, utilisés seulement quand la base est
//! injoignable (première installation, base pas encore configurée).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserJson {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub role: String,
}

fn path() -> PathBuf {
    crate::config::data_dir().join("users.json")
}

fn default_admin() -> UserJson {
    UserJson {
        id: "0".into(),
        username: "admin".into(),
        password_hash: super::password::hash_password("admin"),
        role: "admin".into(),
    }
}

/// Comptes de secours (créés avec admin/admin si le fichier n'existe pas).
pub fn get_fallback_users() -> Vec<UserJson> {
    let p = path();
    if !p.exists() {
        let admin = default_admin();
        save_fallback_users(&[admin.clone()]);
        return vec![admin];
    }
    match std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(users) => users,
        None => {
            tracing::error!("[AUTH] Error reading users.json");
            vec![]
        }
    }
}

pub fn save_fallback_users(users: &[UserJson]) {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&p, serde_json::to_string_pretty(users).unwrap_or_default()) {
        tracing::error!("[AUTH] Error writing users.json: {e}");
    }
}

/// Base injoignable : le fichier de secours doit contenir au moins un administrateur.
pub fn assurer_admin_de_secours() {
    if get_fallback_users().is_empty() {
        tracing::info!("[AUTH] Initializing local JSON fallback with admin/admin...");
        save_fallback_users(&[default_admin()]);
    }
}
