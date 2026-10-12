//! Points d'appel vers les modules `qlik` et `ff` utilisés par les Paramètres.
//! Branchés après l'intégration de ces modules.

use serde_json::{json, Value};

/// Ouvre une session Qlik (NTLM → ticket → cookie) avec les identifiants donnés.
pub async fn tester_session(_host: String, _user: String, _password: Option<String>) -> anyhow::Result<()> {
    anyhow::bail!("Test Qlik indisponible : module en cours de portage")
}

/// Oublie l'URL mémorisée de l'API FF Nancy.
pub fn reset_ff_api_base() {}

/// Diagnostic de l'API FF Nancy.
pub async fn diagnostiquer_api_ff(base: Option<String>) -> Value {
    json!({ "success": false, "url": base.unwrap_or_default(), "error": "Diagnostic indisponible : module en cours de portage" })
}
