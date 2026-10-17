//! Fichier de configuration `data/.db-config.json` (réglages saisis dans Paramètres).
//!
//! Le fichier contient des mots de passe et des clés d'API : il ne repart jamais
//! tel quel vers le navigateur. Les clés inconnues sont conservées à l'écriture.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

/// Répertoire des données persistantes (volume Docker `/app/data`).
pub fn data_dir() -> PathBuf {
    std::env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default().join("data"))
}

pub fn config_file() -> PathBuf {
    data_dir().join(".db-config.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub open_router_key: Option<String>,
    #[serde(default)]
    pub open_router_model: Option<String>,
    #[serde(default)]
    pub ai_provider: Option<String>,
    #[serde(default)]
    pub google_ai_key: Option<String>,
    #[serde(default)]
    pub google_ai_model: Option<String>,
    /// Qlik Sense — données réseau.
    #[serde(default)]
    pub qlik_host: Option<String>,
    #[serde(default)]
    pub qlik_user: Option<String>,
    #[serde(default)]
    pub qlik_password: Option<String>,
    /// API REST FF Nancy (ex. https://api.ffnancy.fr).
    #[serde(default)]
    pub ff_api_base_url: Option<String>,
    /// Clé d'API FF Nancy, envoyée dans l'en-tête `X-API-Key`.
    #[serde(default)]
    pub ff_api_key: Option<String>,
}

fn read_raw_sync() -> Map<String, Value> {
    std::fs::read_to_string(config_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// Lit la config existante (vide si absente ou illisible).
pub fn read_config() -> DbConfig {
    serde_json::from_value(Value::Object(read_raw_sync())).unwrap_or_default()
}

/// Fusionne `patch` dans la config enregistrée : les clés absentes du patch sont
/// conservées ; une clé passée à `null` est retirée.
pub fn write_config(patch: Map<String, Value>) -> std::io::Result<()> {
    let mut existing = read_raw_sync();
    for (k, v) in patch {
        if v.is_null() {
            existing.remove(&k);
        } else {
            existing.insert(k, v);
        }
    }
    std::fs::create_dir_all(data_dir())?;
    let text = serde_json::to_string_pretty(&Value::Object(existing)).unwrap_or_else(|_| "{}".into());
    std::fs::write(config_file(), text)
}

/// Chaîne non vide, sinon `None`.
pub fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// URL de connexion PostgreSQL : réglage enregistré, sinon `DATABASE_URL`.
pub fn database_url() -> Option<String> {
    non_empty(read_config().url).or_else(|| non_empty(std::env::var("DATABASE_URL").ok()))
}

/// Variable d'environnement numérique bornée (équivalent de `envNumber` côté TS).
pub fn env_number(name: &str, default: i64, min: i64, max: i64) -> i64 {
    match std::env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => match raw.trim().parse::<f64>() {
            Ok(v) if v.is_finite() => (v.trunc() as i64).clamp(min, max),
            _ => default,
        },
        _ => default,
    }
}
