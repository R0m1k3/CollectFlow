//! Actions des Paramètres — réservées aux administrateurs.
//!
//! Aucun secret ne repart vers le navigateur : les mots de passe (base, Qlik)
//! et les clés d'IA restent dans `data/.db-config.json`. Un mot de passe laissé
//! vide dans le formulaire signifie « conserver celui qui est enregistré ».

use crate::config::{read_config, write_config};
use crate::error::AppResult;
use crate::rpc::{json, Ctx};
use serde::{Deserialize, Serialize};
use serde_json::{json as j, Map, Value};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct ChampsBaseDeDonnees {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    /// Vide ou absent : le mot de passe enregistré est conservé.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssl: bool,
}

struct UrlPostgres {
    host: String,
    port: String,
    database: String,
    user: String,
    password: String,
    ssl: bool,
}

fn decoder(v: &str) -> String {
    urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string())
}

/// Découpe l'URL `postgres://` enregistrée en champs du formulaire.
fn lire_url_postgres(url: &str) -> Option<UrlPostgres> {
    let re = regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*://(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?(?:/([^?#]*))?").unwrap();
    let Some(c) = re.captures(url) else {
        tracing::error!("[Settings] URL de base enregistrée illisible");
        return None;
    };
    Some(UrlPostgres {
        host: c.get(3).map(|m| m.as_str().to_string()).unwrap_or_default(),
        port: c.get(4).map(|m| m.as_str().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "5432".into()),
        database: decoder(c.get(5).map(|m| m.as_str()).unwrap_or_default()),
        user: decoder(c.get(1).map(|m| m.as_str()).unwrap_or_default()),
        password: decoder(c.get(2).map(|m| m.as_str()).unwrap_or_default()),
        ssl: url.contains("sslmode=require"),
    })
}

fn construire_url_postgres(champs: &ChampsBaseDeDonnees, mot_de_passe: &str) -> String {
    let user = urlencoding::encode(champs.user.trim()).into_owned();
    let identifiants = if mot_de_passe.is_empty() {
        user
    } else {
        format!("{user}:{}", urlencoding::encode(mot_de_passe))
    };
    let port = Some(champs.port.trim()).filter(|p| !p.is_empty()).unwrap_or("5432");
    format!(
        "postgres://{identifiants}@{}:{port}/{}{}",
        champs.host.trim(),
        champs.database.trim(),
        if champs.ssl { "?sslmode=require" } else { "" }
    )
}

/// Mot de passe saisi, sinon celui de l'URL enregistrée.
fn mot_de_passe_base(champs: &ChampsBaseDeDonnees) -> String {
    if let Some(p) = champs.password.as_ref().filter(|p| !p.is_empty()) {
        return p.clone();
    }
    read_config().url.as_deref().and_then(lire_url_postgres).map(|u| u.password).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbAffichable {
    host: String,
    port: String,
    database: String,
    user: String,
    ssl: bool,
    mot_de_passe_enregistre: bool,
}

/// Réglages enregistrés, sans aucun secret.
pub async fn get_parametres_affichables(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;
    let config = read_config();
    let base = config.url.as_deref().and_then(lire_url_postgres);
    let db = base.map(|b| DbAffichable {
        host: b.host,
        port: b.port,
        database: b.database,
        user: b.user,
        ssl: b.ssl,
        mot_de_passe_enregistre: !b.password.is_empty(),
    });
    let qlik_pwd_env = std::env::var("QLIK_PWD").map(|v| !v.is_empty()).unwrap_or(false);
    json(j!({
        "db": db,
        "qlik": {
            "host": config.qlik_host.clone().unwrap_or_default(),
            "user": config.qlik_user.clone().unwrap_or_default(),
            // Même ordre de priorité que la config Qlik : réglage enregistré, puis variable d'environnement.
            "motDePasseEnregistre": config.qlik_password.as_deref().map(|p| !p.is_empty()).unwrap_or(false) || qlik_pwd_env,
        },
        "ffApiBaseUrl": config.ff_api_base_url.clone().unwrap_or_default(),
    }))
}

fn refus(e: crate::error::AppError) -> Value {
    j!({ "success": false, "error": e.message })
}

pub async fn test_database_connection(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.admin().await {
        return Ok(refus(e));
    }
    let champs: ChampsBaseDeDonnees = ctx.arg(0)?;
    let url = construire_url_postgres(&champs, &mot_de_passe_base(&champs));
    tracing::info!("Testing connection to: {}", crate::db::mask_url(&url));
    let essai = async {
        let opts = crate::db::connect_options(&url)?;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect_with(opts)
            .await?;
        sqlx::query("SELECT 1").execute(&pool).await?;
        pool.close().await;
        Ok::<_, sqlx::Error>(())
    };
    match tokio::time::timeout(Duration::from_secs(8), essai).await {
        Ok(Ok(())) => Ok(j!({ "success": true })),
        Ok(Err(e)) => {
            tracing::error!("Database connection test failed: {e}");
            Ok(j!({ "success": false, "error": e.to_string() }))
        }
        Err(_) => Ok(j!({ "success": false, "error": "timeout exceeded when trying to connect" })),
    }
}

pub async fn save_database_settings(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.admin().await {
        return Ok(refus(e));
    }
    let champs: ChampsBaseDeDonnees = ctx.arg(0)?;
    let url = construire_url_postgres(&champs, &mot_de_passe_base(&champs));
    // Seule l'URL change : les clés d'IA et les réglages Qlik / API FF sont conservés.
    tracing::info!("[Settings] Saving config to {}", crate::config::config_file().display());
    let mut patch = Map::new();
    patch.insert("url".into(), Value::String(url));
    match write_config(patch) {
        Ok(()) => {
            tracing::info!("[Settings] Database configuration saved successfully.");
            crate::db::refresh();
            // Nouvelle base : schéma et compte admin à (re)vérifier.
            tokio::spawn(async {
                crate::migrations::run().await;
                crate::auth::ensure_admin_exists().await;
            });
            Ok(j!({ "success": true }))
        }
        Err(e) => {
            tracing::error!("Failed to save database configuration: {e}");
            Ok(j!({ "success": false, "error": e.to_string() }))
        }
    }
}

/// Mot de passe vide ou absent : celui qui est enregistré est conservé.
pub async fn save_qlik_settings(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.admin().await {
        return Ok(refus(e));
    }
    let host: String = ctx.arg::<Option<String>>(0)?.unwrap_or_default();
    let user: String = ctx.arg::<Option<String>>(1)?.unwrap_or_default();
    let password: Option<String> = ctx.arg::<Option<String>>(2)?.filter(|p| !p.is_empty());
    let mut patch = Map::new();
    patch.insert("qlikHost".into(), Value::String(host));
    patch.insert("qlikUser".into(), Value::String(user));
    if let Some(p) = password {
        patch.insert("qlikPassword".into(), Value::String(p));
    }
    match write_config(patch) {
        Ok(()) => {
            tracing::info!("[Settings] Qlik configuration saved.");
            Ok(j!({ "success": true }))
        }
        Err(e) => {
            tracing::error!("[Settings] Failed to save Qlik config: {e}");
            Ok(j!({ "success": false, "error": e.to_string() }))
        }
    }
}

/// Mot de passe vide ou absent : on teste avec celui qui est enregistré.
pub async fn test_qlik_connection(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.admin().await {
        return Ok(refus(e));
    }
    let host: String = ctx.arg::<Option<String>>(0)?.unwrap_or_default();
    let user: String = ctx.arg::<Option<String>>(1)?.unwrap_or_default();
    let password: Option<String> = ctx.arg::<Option<String>>(2)?.filter(|p| !p.is_empty());
    match super::qlik_bridge::tester_session(host, user, password).await {
        Ok(()) => Ok(j!({ "success": true })),
        Err(e) => Ok(j!({ "success": false, "error": format!("{e:#}") })),
    }
}

/// Enregistre l'URL de l'API FF Nancy. Chaîne vide = revenir au défaut.
pub async fn save_ff_api_settings(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.admin().await {
        return Ok(refus(e));
    }
    let brut: String = ctx.arg::<Option<String>>(0)?.unwrap_or_default();
    let cleaned = brut.trim().trim_end_matches('/').to_string();
    let lower = cleaned.to_ascii_lowercase();
    if !cleaned.is_empty() && !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Ok(j!({ "success": false, "error": "L'URL doit commencer par http:// ou https://" }));
    }
    let mut patch = Map::new();
    patch.insert("ffApiBaseUrl".into(), if cleaned.is_empty() { Value::Null } else { Value::String(cleaned.clone()) });
    match write_config(patch) {
        Ok(()) => {
            // Sans cela, l'ancienne URL resterait servie jusqu'à 30 s après la sauvegarde.
            super::qlik_bridge::reset_ff_api_base();
            tracing::info!("[Settings] FF API base URL saved: {}", if cleaned.is_empty() { "(défaut)" } else { &cleaned });
            Ok(j!({ "success": true }))
        }
        Err(e) => {
            tracing::error!("[Settings] Failed to save FF API config: {e}");
            Ok(j!({ "success": false, "error": e.to_string() }))
        }
    }
}

/// Teste l'API FF Nancy.
pub async fn test_ff_api_connection(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.admin().await {
        return Ok(j!({ "success": false, "url": "", "error": e.message }));
    }
    let base: Option<String> = ctx.arg(0)?;
    Ok(super::qlik_bridge::diagnostiquer_api_ff(base).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_roundtrip() {
        let champs = ChampsBaseDeDonnees {
            host: "db".into(),
            port: "".into(),
            database: "cf".into(),
            user: "u@x".into(),
            password: Some("p:ss/w".into()),
            ssl: true,
        };
        let url = construire_url_postgres(&champs, "p:ss/w");
        assert_eq!(url, "postgres://u%40x:p%3Ass%2Fw@db:5432/cf?sslmode=require");
        let u = lire_url_postgres(&url).unwrap();
        assert_eq!((u.host.as_str(), u.port.as_str(), u.database.as_str(), u.user.as_str(), u.password.as_str(), u.ssl), ("db", "5432", "cf", "u@x", "p:ss/w", true));
        let u = lire_url_postgres("postgres://postgres:secret@postgresbase:5432/collectflow").unwrap();
        assert_eq!((u.host.as_str(), u.user.as_str(), u.password.as_str(), u.database.as_str()), ("postgresbase", "postgres", "secret", "collectflow"));
    }
}
