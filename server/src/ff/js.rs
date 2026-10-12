//! Conversions « à la JavaScript » sur des valeurs JSON brutes de l'API FF.
//!
//! Le code TS d'origine lisait les réponses de l'API sans schéma et convertissait
//! au fil de l'eau (`Number(x) || 0`, `String(x)`, tests de vérité). Ces aides
//! reproduisent ces conversions pour garder exactement les mêmes résultats.

use serde_json::Value;

/// `Number(v)` : `NaN` si la valeur n'est pas convertible.
pub fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                // Rust accepte « inf » / « nan », pas JS (seul « Infinity » l'est, cas ignoré).
                let l = t.to_ascii_lowercase();
                if l.contains("inf") || l.contains("nan") {
                    f64::NAN
                } else {
                    t.parse::<f64>().unwrap_or(f64::NAN)
                }
            }
        }
        Value::Array(a) => match a.len() {
            0 => 0.0,
            1 => js_number(&a[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(v) || 0` (NaN et 0 ramenés à 0).
pub fn js_number_or0(v: &Value) -> f64 {
    let n = js_number(v);
    if n.is_nan() {
        0.0
    } else {
        n
    }
}

/// `Number(v)` sur une valeur éventuellement absente (`undefined` → NaN).
pub fn js_number_opt(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(v) => js_number(v),
    }
}

/// Formatage d'un nombre comme `String(n)` en JS (12 → "12", 1.5 → "1.5").
pub fn js_number_to_string(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{}", f as i128)
    } else {
        format!("{f}")
    }
}

/// `String(v)`.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => js_number_to_string(f),
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Valeur « vraie » au sens JS (`if (v)`).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `v?.[key]` : `None` si absent (undefined).
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

/// `a ?? b ?? …` sur les clés d'un objet : première valeur ni absente ni `null`.
pub fn coalesce<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| get(v, k)).find(|x| !x.is_null())
}

/// Chaîne d'une valeur JSON, `None` si absente ou `null` (`x ?? undefined`).
pub fn opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(x) => Some(js_string(x)),
    }
}

/// Message d'une erreur et de ses causes, sans répéter une cause déjà incluse
/// dans le message précédent (les erreurs SQL recopient leur cause).
pub fn message_erreur(e: &anyhow::Error) -> String {
    let mut parts: Vec<String> = vec![];
    for cause in e.chain() {
        let m = cause.to_string();
        if !parts.iter().any(|p| p.contains(&m)) {
            parts.push(m);
        }
    }
    parts.join(": ")
}

/// `encodeURIComponent(String(v))`.
pub fn encode(v: &str) -> String {
    urlencoding::encode(v).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_conversions() {
        assert_eq!(js_number(&json!("12.5")), 12.5);
        assert_eq!(js_number(&json!(" ")), 0.0);
        assert!(js_number(&json!("abc")).is_nan());
        assert_eq!(js_number_or0(&json!("abc")), 0.0);
        assert_eq!(js_number(&json!(true)), 1.0);
        assert_eq!(js_number(&Value::Null), 0.0);
        assert!(js_number_opt(None).is_nan());
    }

    #[test]
    fn string_conversions() {
        assert_eq!(js_string(&json!(12)), "12");
        assert_eq!(js_string(&json!(12.0)), "12");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&json!("x")), "x");
        assert_eq!(js_number_to_string(2.0), "2");
        assert!(truthy(&json!("a")));
        assert!(!truthy(&json!("")));
        assert!(!truthy(&json!(0)));
    }
}
