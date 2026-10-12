//! Points d'appel vers les modules `qlik` et `ff` utilisés par les Paramètres.
//! Branchés après l'intégration de ces modules.

use serde_json::Value;

/// Ouvre une session Qlik (NTLM → ticket → cookie) avec les identifiants donnés.
pub async fn tester_session(host: String, user: String, password: Option<String>) -> anyhow::Result<()> {
    let enregistre = crate::qlik::client::get_qlik_config();
    let mut cfg = enregistre.clone();
    cfg.user = user;
    cfg.password = password.unwrap_or(enregistre.password);
    if !host.is_empty() {
        cfg.host = host;
    }
    crate::qlik::client::qlik_ntlm_session(&cfg).await?;
    Ok(())
}

/// Oublie l'URL mémorisée de l'API FF Nancy.
pub fn reset_ff_api_base() {
    crate::ff::api::reset_ff_api_base_cache();
}

/// Diagnostic de l'API FF Nancy.
pub async fn diagnostiquer_api_ff(base: Option<String>) -> Value {
    serde_json::to_value(crate::ff::diagnostic::diagnostiquer_api_ff(base).await).unwrap_or(Value::Null)
}

/// Extraction Qlik d'un fournisseur sur la fenêtre de la synchro (`QLIK_SYNC_MONTHS_BACK`),
/// puis enregistrement dans le cache réseau. Renvoie le nombre de codes enregistrés.
pub async fn extraire_et_enregistrer(codes: Vec<String>, fournisseur: &str) -> anyhow::Result<usize> {
    use crate::qlik::date_range::{build_grid_network_qlik_date_filter_now, env_months_back, QLIK_MONTHS_BACK_DEFAULT};
    let filtre = build_grid_network_qlik_date_filter_now(env_months_back("QLIK_SYNC_MONTHS_BACK", QLIK_MONTHS_BACK_DEFAULT));
    let metrics = crate::qlik::fetch_network_metrics_playwright(Some(codes), None, Some(filtre), Some(fournisseur.to_string())).await?;
    let liste: Vec<_> = metrics.into_values().collect();
    crate::qlik::upsert_network_metrics(&liste).await
}
