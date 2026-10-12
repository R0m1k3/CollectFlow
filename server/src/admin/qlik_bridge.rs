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
