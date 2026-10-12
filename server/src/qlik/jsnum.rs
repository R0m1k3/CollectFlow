//! Nombres « à la JavaScript » pour la (dé)sérialisation des métriques Qlik.
//!
//! `JSON.stringify(12)` donne `12`, là où serde_json écrit `12.0` pour un `f64` ;
//! `NaN` / `Infinity` deviennent `null`. Les métriques partent telles quelles
//! vers l'interface et dans des colonnes `jsonb` : on garde l'écriture du TS.
//! En lecture, on tolère `null` (NaN côté page) et les chaînes numériques.

use serde::{Deserialize, Deserializer, Serializer};
use serde_json::Value;
use std::collections::BTreeMap;

/// Valeur JSON d'un nombre, écrite comme `JSON.stringify`.
pub fn valeur(v: f64) -> Value {
    if !v.is_finite() {
        Value::Null
    } else if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// `String(v)` en JS (journaux et messages).
pub fn texte(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        valeur(v).to_string()
    }
}

/// `Number(v)` sur une valeur JSON (NaN si non convertible).
pub fn nombre(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => super::date_range::js_number(s),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// `Number(v) || 0`.
pub fn nombre_ou_0(v: Option<&Value>) -> f64 {
    let n = v.map(nombre).unwrap_or(f64::NAN);
    if n.is_nan() {
        0.0
    } else {
        n
    }
}

pub fn ser<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&valeur(*v), s)
}

pub fn ser_opt<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => ser(x, s),
        None => s.serialize_none(),
    }
}

pub fn ser_map<S: Serializer>(v: &Option<BTreeMap<String, f64>>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(m) => {
            let obj: serde_json::Map<String, Value> = m.iter().map(|(k, x)| (k.clone(), valeur(*x))).collect();
            serde::Serialize::serialize(&obj, s)
        }
        None => s.serialize_none(),
    }
}

/// `null` → NaN (une valeur NaN de la page devient `null` en JSON).
fn depuis_valeur(v: &Value) -> f64 {
    match v {
        Value::Null => f64::NAN,
        autre => nombre(autre),
    }
}

pub fn de<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(depuis_valeur(&Value::deserialize(d)?))
}

pub fn de_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => None,
        v => Some(nombre(&v)),
    })
}

pub fn de_map<'de, D: Deserializer<'de>>(d: D) -> Result<Option<BTreeMap<String, f64>>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Object(m) => Some(m.iter().map(|(k, v)| (k.clone(), depuis_valeur(v))).collect()),
        _ => None,
    })
}
