//! Comptes de secours `data/users.json`, utilisés seulement pendant la première
//! installation : base pas encore configurée ou injoignable, et jamais encore
//! atteinte. Dès que la base a répondu une fois (`data/.db-initialisee`), ils
//! sont désactivés : une panne de la base ne rouvre plus d'accès de secours.
//! Le compte de secours n'a jamais le mot de passe « admin » : `ADMIN_PASSWORD`,
//! ou un mot de passe aléatoire écrit une seule fois dans les journaux.

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

fn marqueur_base() -> PathBuf {
    crate::config::data_dir().join(".db-initialisee")
}

/// La base a déjà répondu au moins une fois : comptes de secours désactivés.
pub fn base_deja_initialisee() -> bool {
    marqueur_base().exists()
}

/// Note que la base répond (appelé après un amorçage réussi).
pub fn marquer_base_initialisee() {
    let p = marqueur_base();
    if p.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(crate::config::data_dir());
    match std::fs::write(&p, chrono::Utc::now().to_rfc3339()) {
        Ok(()) => tracing::info!("[AUTH] Base atteinte : comptes de secours (users.json) désactivés."),
        Err(e) => tracing::warn!("[AUTH] Marqueur {} non écrit : {e}", p.display()),
    }
}

fn default_admin() -> UserJson {
    let mot_de_passe = super::mot_de_passe_initial("compte de secours admin créé (data/users.json)");
    UserJson {
        id: "0".into(),
        username: "admin".into(),
        password_hash: super::password::hash_password(&mot_de_passe),
        role: "admin".into(),
    }
}

/// Comptes de secours (créés avec un administrateur si le fichier n'existe pas).
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

/// Base injoignable : le fichier de secours doit contenir au moins un
/// administrateur, et aucun compte n'y garde le mot de passe « admin » des
/// anciennes versions (vérifié une fois par processus).
pub fn assurer_admin_de_secours() {
    static VERIFIE: std::sync::Once = std::sync::Once::new();
    let mut users = get_fallback_users();
    if users.is_empty() {
        save_fallback_users(&[default_admin()]);
        return;
    }
    VERIFIE.call_once(|| {
        let mut change = false;
        for user in users.iter_mut() {
            if super::password::verify_password("admin", &user.password_hash) {
                let mot_de_passe = super::mot_de_passe_initial(&format!(
                    "compte de secours « {} » : ancien mot de passe « admin » remplacé",
                    user.username
                ));
                user.password_hash = super::password::hash_password(&mot_de_passe);
                change = true;
            }
        }
        if change {
            save_fallback_users(&users);
        }
    });
}
