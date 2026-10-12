//! Accès et identifiant utilisateur, tels que les actions TS les manipulent.

use super::js;
use crate::auth::UtilisateurCourant;
use crate::error::AppResult;
use crate::rpc::Ctx;
use axum::http::StatusCode;
use serde_json::{Map, Value};

/// `verifierSession()` : `Ok(Ok(u))` si connecté, `Ok(Err(message))` pour un
/// refus d'accès (401/403) que l'action renvoie dans `{ success: false, error }`.
/// Toute autre erreur est propagée, comme le `throw e` du TS.
pub async fn verifier_session(ctx: &Ctx) -> AppResult<Result<UtilisateurCourant, String>> {
    match ctx.session().await {
        Ok(u) => Ok(Ok(u)),
        Err(e) if e.status == StatusCode::UNAUTHORIZED || e.status == StatusCode::FORBIDDEN => Ok(Err(e.message)),
        Err(e) => Err(e),
    }
}

/// `rawUserId ? parseInt(rawUserId, 10) : null` — `None` pour `null`, sinon le
/// nombre (éventuellement `NaN`).
pub fn parse_user_id(raw: &str) -> Option<f64> {
    if raw.is_empty() {
        None
    } else {
        Some(js::js_parse_int(raw))
    }
}

/// `userId && !isNaN(userId) ? userId : null` : le compte de secours « 0 » et les
/// identifiants non numériques valent `null` (snapshots « anonymes »).
pub fn final_user_id(raw: &str) -> Option<f64> {
    parse_user_id(raw).filter(|v| *v != 0.0 && !v.is_nan())
}

/// Représentation de `${userId}` dans les journaux.
pub fn user_id_log(raw: &str) -> String {
    match parse_user_id(raw) {
        None => "null".into(),
        Some(v) => js::js_number_to_string(v),
    }
}

/// Valeur liée à une colonne `integer` : hors bornes, PostgreSQL refuse la
/// requête (« value out of range for type integer ») — même issue qu'en TS.
pub fn as_pg_integer(v: f64) -> Result<i32, String> {
    if v.fract() == 0.0 && v >= i32::MIN as f64 && v <= i32::MAX as f64 {
        Ok(v as i32)
    } else {
        Err(format!("value \"{}\" is out of range for type integer", js::js_number_to_string(v)))
    }
}

/// Clés d'un objet dans l'ordre où JS les énumère : indices entiers croissants
/// d'abord (« 123456 » est un indice), puis les autres dans l'ordre d'insertion.
pub fn js_key_order(m: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let indice = js::js_array_index;
    let mut entiers: Vec<(u64, &String, &Value)> = Vec::new();
    let mut autres = Vec::new();
    for (k, v) in m {
        match indice(k) {
            Some(i) => entiers.push((i, k, v)),
            None => autres.push((k, v)),
        }
    }
    entiers.sort_by_key(|(i, _, _)| *i);
    entiers.into_iter().map(|(_, k, v)| (k, v)).chain(autres).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiants_comme_en_ts() {
        assert_eq!(final_user_id("12"), Some(12.0));
        assert_eq!(final_user_id("12abc"), Some(12.0));
        assert_eq!(final_user_id("0"), None);
        assert_eq!(final_user_id("abc"), None);
        assert_eq!(final_user_id(""), None);
        assert_eq!(user_id_log("abc"), "NaN");
        assert_eq!(user_id_log(""), "null");
        assert_eq!(user_id_log("0"), "0");
        assert!(as_pg_integer(99_999_999_999.0).is_err());
        assert_eq!(as_pg_integer(-5.0), Ok(-5));
    }

    #[test]
    fn ordre_des_cles_js() {
        let v: Value = serde_json::from_str(r#"{"b":1,"20":2,"a":3,"3":4,"007":5}"#).unwrap();
        let ordre: Vec<&str> = js_key_order(v.as_object().unwrap()).into_iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(ordre, vec!["3", "20", "b", "a", "007"]);
    }
}
