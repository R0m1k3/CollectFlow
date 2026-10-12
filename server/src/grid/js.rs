//! Équivalents des conversions JavaScript dont dépend le comportement du code TS
//! d'origine : `Number(…)`, `parseInt(…, 10)`, `String(nombre)`, `Math.round`,
//! `toFixed`, et la sérialisation JSON des nombres (`12` et non `12.0`).
//!
//! Les nombres de `ProductRow` sont des `f64` ; `JSON.stringify` écrit un entier
//! sans décimale et `NaN` en `null`. Les modules de sérialisation ci-dessous
//! reproduisent ces deux règles, et relisent un `null` en `NaN` pour qu'une ligne
//! persistée par la version Node fasse l'aller-retour à l'identique.

use serde::de::Deserializer;
use serde::ser::{SerializeMap, Serializer};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// Espace blanc au sens de JS (`trim`, `\s`).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `s.replace(/\s+/g, remplacement)`.
pub fn replace_whitespace_runs(s: &str, remplacement: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut dans_blanc = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            if !dans_blanc {
                out.push_str(remplacement);
                dans_blanc = true;
            }
        } else {
            dans_blanc = false;
            out.push(c);
        }
    }
    out
}

static DECIMAL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$").unwrap());

/// `Number(s)` pour une chaîne (coercition de `z.coerce.number()`).
pub fn js_number_from_str(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let base = |chiffres: &str, radix: u32| -> f64 {
        if chiffres.is_empty() {
            return f64::NAN;
        }
        let mut v = 0f64;
        for c in chiffres.chars() {
            match c.to_digit(radix) {
                Some(d) => v = v * radix as f64 + d as f64,
                None => return f64::NAN,
            }
        }
        v
    };
    let prefixe = |p: &[&str]| p.iter().find_map(|x| t.strip_prefix(x));
    if let Some(r) = prefixe(&["0x", "0X"]) {
        return base(r, 16);
    }
    if let Some(r) = prefixe(&["0o", "0O"]) {
        return base(r, 8);
    }
    if let Some(r) = prefixe(&["0b", "0B"]) {
        return base(r, 2);
    }
    if !DECIMAL.is_match(t) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseInt(s, 10)` : préfixe numérique, `NaN` s'il n'y en a pas.
pub fn js_parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_whitespace);
    let (negatif, reste) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let fin = reste.bytes().take_while(|b| b.is_ascii_digit()).count();
    if fin == 0 {
        return f64::NAN;
    }
    let v: f64 = reste[..fin].parse().unwrap_or(f64::NAN);
    if negatif {
        -v
    } else {
        v
    }
}

/// `String(x)` pour un nombre (`Number.prototype.toString()`).
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let signe = if x < 0.0 { "-" } else { "" };
    // `{:e}` donne les chiffres les plus courts qui relisent la même valeur,
    // exactement ceux que retient l'algorithme de JS.
    let e = format!("{:e}", x.abs());
    let (mantisse, exposant) = e.split_once('e').unwrap_or((&e, "0"));
    let chiffres: String = mantisse.chars().filter(|c| *c != '.').collect();
    let k = chiffres.len() as i64;
    let n = exposant.parse::<i64>().unwrap_or(0) + 1;
    let corps = if k <= n && n <= 21 {
        format!("{chiffres}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &chiffres[..n as usize], &chiffres[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{chiffres}", "0".repeat((-n) as usize))
    } else {
        let reste = if k > 1 { format!(".{}", &chiffres[1..]) } else { String::new() };
        let e = n - 1;
        format!("{}{reste}e{}{}", &chiffres[..1], if e < 0 { "-" } else { "+" }, e.abs())
    };
    format!("{signe}{corps}")
}

/// `String(v)` pour une valeur JSON quelconque (argument d'action non typé).
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                autre => js_string(Some(autre)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Valeur « vraie » au sens de JS.
pub fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Math.round(x)` : demi arrondi vers +∞ (`Math.round(-2.5) === -2`).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `parseFloat(x.toFixed(2))`.
///
/// `toFixed` arrondit la valeur binaire exacte ; en cas d'égalité parfaite
/// (0,125 → « 0.13 »), il retient le plus grand entier en valeur absolue, là où
/// le formatage de Rust arrondit au pair.
pub fn js_to_fixed2(x: f64) -> f64 {
    if !x.is_finite() || x.abs() >= 1e21 {
        return x;
    }
    let a = x.abs();
    // Une égalité exacte au millième n'est possible que pour un multiple de 1/8.
    let huitiemes = a * 8.0;
    let r = if huitiemes.fract() == 0.0 && huitiemes < 9.0e15 {
        let centiemes = a * 100.0; // exact : multiple de 12,5
        let f = centiemes.floor();
        let c = if centiemes - f >= 0.5 { f + 1.0 } else { f };
        c / 100.0
    } else {
        format!("{a:.2}").parse::<f64>().unwrap_or(a)
    };
    if x < 0.0 {
        -r
    } else {
        r
    }
}

/// Clé d'objet qui est un indice de tableau pour JS (`"0"`, `"404"`, `"123456"`) :
/// ces clés sont énumérées avant les autres, par ordre croissant.
pub fn js_array_index(k: &str) -> Option<u64> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u64>().ok().filter(|v| *v < u32::MAX as u64)
}

/// Réordonne un objet comme JS énumère ses clés : indices croissants, puis les
/// autres clés dans l'ordre d'insertion.
pub fn js_object_order(m: Map<String, Value>) -> Map<String, Value> {
    if !m.keys().any(|k| js_array_index(k).is_some()) {
        return m;
    }
    let mut indices: Vec<(u64, String, Value)> = Vec::new();
    let mut autres: Vec<(String, Value)> = Vec::new();
    for (k, v) in m {
        match js_array_index(&k) {
            Some(i) => indices.push((i, k, v)),
            None => autres.push((k, v)),
        }
    }
    indices.sort_by_key(|(i, _, _)| *i);
    indices.into_iter().map(|(_, k, v)| (k, v)).chain(autres).collect()
}

/// Texte d'un nombre pour une colonne `numeric` (équivalent de `String(n)`).
pub fn numeric_text(x: f64) -> String {
    js_number_to_string(x)
}

// ---------------------------------------------------------------------------
// Sérialisation des nombres façon `JSON.stringify`
// ---------------------------------------------------------------------------

/// Nombre sérialisé comme le ferait `JSON.stringify` : entier sans décimale,
/// `null` pour `NaN`/`Infinity`.
pub struct JsNum(pub f64);

impl serde::Serialize for JsNum {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        if !v.is_finite() {
            s.serialize_unit()
        } else if v.fract() == 0.0 && v.abs() < 9.0e15 {
            s.serialize_i64(v as i64)
        } else {
            s.serialize_f64(v)
        }
    }
}

/// `f64` (un `null` relu vaut `NaN`).
pub mod num {
    use super::*;
    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&JsNum(*v), s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
    }
}

/// `Option<f64>` d'un champ facultatif (présent à `null` → `Some(NaN)`).
pub mod opt_num {
    use super::*;
    pub fn serialize<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => serde::Serialize::serialize(&JsNum(*x), s),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        Ok(Some(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN)))
    }
}

fn ser_map<S: Serializer>(m: &BTreeMap<String, f64>, s: S) -> Result<S::Ok, S::Error> {
    let mut out = s.serialize_map(Some(m.len()))?;
    for (k, v) in m {
        out.serialize_entry(k, &JsNum(*v))?;
    }
    out.end()
}

fn de_map<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, f64>, D::Error> {
    let brut = Option::<BTreeMap<String, Option<f64>>>::deserialize(d)?.unwrap_or_default();
    Ok(brut.into_iter().map(|(k, v)| (k, v.unwrap_or(f64::NAN))).collect())
}

/// `Record<string, number>` obligatoire.
pub mod map {
    use super::*;
    pub fn serialize<S: Serializer>(m: &BTreeMap<String, f64>, s: S) -> Result<S::Ok, S::Error> {
        ser_map(m, s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, f64>, D::Error> {
        de_map(d)
    }
}

/// `Record<string, number>` facultatif.
pub mod opt_map {
    use super::*;
    pub fn serialize<S: Serializer>(m: &Option<BTreeMap<String, f64>>, s: S) -> Result<S::Ok, S::Error> {
        match m {
            Some(m) => ser_map(m, s),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<BTreeMap<String, f64>>, D::Error> {
        let brut = Option::<BTreeMap<String, Option<f64>>>::deserialize(d)?;
        Ok(brut.map(|m| m.into_iter().map(|(k, v)| (k, v.unwrap_or(f64::NAN))).collect()))
    }
}

/// `Record<string, number> | null` facultatif : absent (`None`), `null`
/// (`Some(None)`) ou renseigné.
pub mod opt_null_map {
    use super::*;
    pub fn serialize<S: Serializer>(m: &Option<Option<BTreeMap<String, f64>>>, s: S) -> Result<S::Ok, S::Error> {
        match m {
            Some(Some(m)) => ser_map(m, s),
            _ => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<BTreeMap<String, f64>>>, D::Error> {
        let brut = Option::<BTreeMap<String, Option<f64>>>::deserialize(d)?;
        Ok(Some(brut.map(|m| m.into_iter().map(|(k, v)| (k, v.unwrap_or(f64::NAN))).collect())))
    }
}

/// `Record<string, Record<string, number>>` facultatif (ventilations par magasin).
pub mod opt_nested_map {
    use super::*;
    pub type Nested = BTreeMap<String, BTreeMap<String, f64>>;

    struct Interne<'a>(&'a BTreeMap<String, f64>);
    impl serde::Serialize for Interne<'_> {
        fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            ser_map(self.0, s)
        }
    }

    pub fn serialize<S: Serializer>(m: &Option<Nested>, s: S) -> Result<S::Ok, S::Error> {
        match m {
            Some(m) => {
                let mut out = s.serialize_map(Some(m.len()))?;
                for (k, v) in m {
                    out.serialize_entry(k, &Interne(v))?;
                }
                out.end()
            }
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Nested>, D::Error> {
        let brut = Option::<BTreeMap<String, Option<BTreeMap<String, Option<f64>>>>>::deserialize(d)?;
        Ok(brut.map(|m| {
            m.into_iter().map(|(k, v)| (k, v.unwrap_or_default().into_iter().map(|(p, x)| (p, x.unwrap_or(f64::NAN))).collect())).collect()
        }))
    }
}

/// Chaîne obligatoire : un `null` relu devient `""`.
pub mod string {
    use super::*;
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_from_str_comme_js() {
        assert_eq!(js_number_from_str(""), 0.0);
        assert_eq!(js_number_from_str("  "), 0.0);
        assert_eq!(js_number_from_str(" 0x2 "), 2.0);
        assert_eq!(js_number_from_str("0b11"), 3.0);
        assert_eq!(js_number_from_str("0o2"), 2.0);
        assert!(js_number_from_str("-0x2").is_nan());
        assert!(js_number_from_str("1_000").is_nan());
        assert!(js_number_from_str("abc").is_nan());
        assert!(js_number_from_str("inf").is_nan());
        assert_eq!(js_number_from_str("+3"), 3.0);
        assert_eq!(js_number_from_str(".2e1"), 2.0);
        assert_eq!(js_number_from_str("1."), 1.0);
        assert_eq!(js_number_from_str("\t2\n"), 2.0);
        assert_eq!(js_number_from_str("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_number_from_str("1e400"), f64::INFINITY);
    }

    #[test]
    fn parse_int_comme_js() {
        assert_eq!(js_parse_int("12abc"), 12.0);
        assert_eq!(js_parse_int("  -5"), -5.0);
        assert_eq!(js_parse_int("0"), 0.0);
        assert!(js_parse_int("abc").is_nan());
        assert!(js_parse_int("").is_nan());
        assert_eq!(js_parse_int("0x10"), 0.0);
    }

    #[test]
    fn number_to_string_comme_js() {
        assert_eq!(js_number_to_string(123.0), "123");
        assert_eq!(js_number_to_string(-1.5), "-1.5");
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(0.000001), "0.000001");
        assert_eq!(js_number_to_string(1.5e-10), "1.5e-10");
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn arrondis_comme_js() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_to_fixed2(0.125), 0.13);
        assert_eq!(js_to_fixed2(-0.125), -0.13);
        assert_eq!(js_to_fixed2(1.005), 1.0);
        assert_eq!(js_to_fixed2(1234.5678), 1234.57);
    }

    #[test]
    fn nombres_json_comme_js() {
        assert_eq!(serde_json::to_string(&JsNum(12.0)).unwrap(), "12");
        assert_eq!(serde_json::to_string(&JsNum(-0.0)).unwrap(), "0");
        assert_eq!(serde_json::to_string(&JsNum(12.5)).unwrap(), "12.5");
        assert_eq!(serde_json::to_string(&JsNum(f64::NAN)).unwrap(), "null");
    }

    #[test]
    fn string_et_truthy() {
        assert_eq!(js_string(Some(&serde_json::json!(123))), "123");
        assert_eq!(js_string(Some(&serde_json::json!(null))), "null");
        assert_eq!(js_string(None), "undefined");
        assert!(!js_truthy(Some(&serde_json::json!(""))));
        assert!(js_truthy(Some(&serde_json::json!("export"))));
        assert_eq!(replace_whitespace_runs("Le  Fournisseur\tX", "_"), "Le_Fournisseur_X");
    }
}
