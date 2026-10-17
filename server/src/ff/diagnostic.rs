//! CollectFlow — Diagnostic de l'API FF Nancy
//! (port de `src/features/settings/ff-api-diagnostic.ts`).
//!
//! Partagé par le bouton « Tester » des Paramètres (administrateurs) et par la
//! route `/api/ff-status` (tout utilisateur connecté). Chaque appelant fait son
//! propre contrôle d'accès.

use super::api::{get_ff_api_key, normalize_sync_status, status_text, FfSyncStatus, FF_API_BASE_DEFAULT, FF_API_KEY_HEADER};
use super::js::truthy;
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};

/// Résultat du diagnostic : `{ success: true, url, ms, status }` ou
/// `{ success: false, url, error }`.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticApiFf {
    pub success: bool,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<FfSyncStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DiagnosticApiFf {
    fn echec(url: &str, error: String) -> Self {
        Self { success: false, url: url.to_string(), ms: None, status: None, error: Some(error) }
    }
}

/// Cause réseau d'une erreur `reqwest` : (code façon Node, message).
fn cause_reseau(e: &reqwest::Error) -> Option<(&'static str, String)> {
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    let mut messages = vec![];
    while let Some(s) = source {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => return Some(("ECONNREFUSED", io.to_string())),
                std::io::ErrorKind::ConnectionReset => return Some(("ECONNRESET", io.to_string())),
                std::io::ErrorKind::HostUnreachable => return Some(("EHOSTUNREACH", io.to_string())),
                std::io::ErrorKind::NetworkUnreachable => return Some(("ENETUNREACH", io.to_string())),
                _ => {}
            }
        }
        messages.push(s.to_string());
        source = s.source();
    }
    let tout = messages.join(" ").to_lowercase();
    if tout.contains("dns error") || tout.contains("failed to lookup address") || tout.contains("name or service not known") {
        return Some(("ENOTFOUND", messages.last().cloned().unwrap_or_default()));
    }
    if tout.contains("connection refused") {
        return Some(("ECONNREFUSED", messages.last().cloned().unwrap_or_default()));
    }
    None
}

/// Message complet d'une erreur et de ses causes.
fn message_complet(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = e.source();
    while let Some(s) = source {
        let m = s.to_string();
        if !parts.iter().any(|p| p.contains(&m)) {
            parts.push(m);
        }
        source = s.source();
    }
    parts.join(": ")
}

/// Teste l'API FF Nancy et renvoie un diagnostic **exploitable**.
///
/// L'ancien panneau se contentait d'un « HTTP 503 » opaque : impossible de savoir
/// si l'hôte était injoignable, l'URL erronée ou le service en panne. On distingue
/// donc ici l'échec réseau (DNS, refus de connexion, délai dépassé) du code HTTP.
///
/// `ff_api_key` : clé saisie à tester ; vide ou absente, on reprend la clé enregistrée.
pub async fn diagnostiquer_api_ff(ff_api_base_url: Option<String>, ff_api_key: Option<String>) -> DiagnosticApiFf {
    let cle = match ff_api_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(c) => Some(c),
        None => get_ff_api_key().await,
    };
    let saisie = ff_api_base_url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let base = match saisie {
        Some(b) => b,
        None => {
            let configured = tokio::task::spawn_blocking(|| crate::config::read_config().ff_api_base_url)
                .await
                .ok()
                .flatten()
                .filter(|s| !s.is_empty());
            configured
                .or_else(|| std::env::var("FF_API_BASE_URL").ok().filter(|s| !s.is_empty()))
                .unwrap_or_else(|| FF_API_BASE_DEFAULT.to_string())
        }
    };
    let base = base.trim_end_matches('/').to_string();
    let url = format!("{base}/api/sync/status");
    let started = Instant::now();

    let client = reqwest::Client::builder().timeout(Duration::from_millis(8000)).build().unwrap_or_default();
    let mut req = client.get(&url).header(reqwest::header::CACHE_CONTROL, "no-store");
    if let Some(cle) = &cle {
        req = req.header(FF_API_KEY_HEADER, cle);
    }
    match req.send().await {
        Ok(res) => {
            let ms = started.elapsed().as_millis() as u64;
            // 401/403 : le serveur répond, c'est la clé qui manque ou qui est refusée.
            if matches!(res.status().as_u16(), 401 | 403) {
                return DiagnosticApiFf::echec(
                    &url,
                    if cle.is_some() {
                        format!("Clé d'API refusée (HTTP {}) — vérifiez la clé saisie.", res.status().as_u16())
                    } else {
                        format!("Clé d'API requise (HTTP {}) — renseignez la clé d'API.", res.status().as_u16())
                    },
                );
            }
            if !res.status().is_success() {
                let txt = status_text(res.status());
                return DiagnosticApiFf::echec(
                    &url,
                    format!(
                        "Le serveur a répondu HTTP {} ({}) en {ms} ms.",
                        res.status().as_u16(),
                        if txt.is_empty() { "sans message" } else { txt }
                    ),
                );
            }
            let body = res.json::<Value>().await.ok().filter(truthy);
            let Some(body) = body else {
                return DiagnosticApiFf::echec(&url, "Réponse HTTP 200 mais corps illisible (JSON attendu).".into());
            };
            // La réponse brute de l'API n'a pas la forme attendue par l'interface :
            // sans cette normalisation, le panneau s'affiche vide malgré un HTTP 200.
            match normalize_sync_status(&body) {
                None => DiagnosticApiFf::echec(&url, "Réponse HTTP 200 mais format inattendu (ni « sync » ni « tables »).".into()),
                Some(status) => DiagnosticApiFf { success: true, url, ms: Some(ms), status: Some(status), error: None },
            }
        }
        Err(e) => {
            let ms = started.elapsed().as_millis() as u64;
            let raw = message_complet(&e);
            // La cause réelle se cache derrière l'erreur de haut niveau : on la déplie.
            let hint = if e.is_timeout() {
                format!("Aucune réponse en {ms} ms — serveur injoignable ou trop lent.")
            } else {
                match cause_reseau(&e) {
                    Some(("ENOTFOUND", _)) => "Nom d'hôte introuvable (DNS) — vérifiez l'URL.".to_string(),
                    Some(("ECONNREFUSED", _)) => "Connexion refusée — le service n'écoute pas sur cette adresse.".to_string(),
                    Some((code, msg)) => {
                        if msg.is_empty() {
                            code.to_string()
                        } else {
                            format!("{code} — {msg}")
                        }
                    }
                    None => raw.clone(),
                }
            };
            tracing::error!("[Settings] FF API test KO ({url}): {raw}");
            DiagnosticApiFf::echec(&url, hint)
        }
    }
}
