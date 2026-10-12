//! Validation façon zod (v4) : mêmes contrôles, mêmes « issues ».
//!
//! Les routes `/api/v1` renvoient `parsed.error.issues` dans `error.details`, et
//! certaines actions recopient `parsed.error.message` (le JSON indenté des issues)
//! dans leur message d'erreur. Pour que l'appelant reçoive exactement le même
//! détail, on reproduit la forme des issues de zod 4 : clés dans le même ordre,
//! mêmes messages par défaut, même ordre de parcours (celui du schéma).

use super::js;
use serde_json::{json, Map, Value};

/// Plus grand entier « sûr » de JS (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Segment de chemin d'une issue : clé d'objet ou indice de tableau.
#[derive(Debug, Clone)]
pub enum Seg {
    K(String),
    I(usize),
}

impl From<&str> for Seg {
    fn from(s: &str) -> Self {
        Seg::K(s.to_string())
    }
}
impl From<usize> for Seg {
    fn from(i: usize) -> Self {
        Seg::I(i)
    }
}

pub type Path = Vec<Seg>;

pub fn path_json(path: &[Seg]) -> Value {
    Value::Array(
        path.iter()
            .map(|s| match s {
                Seg::K(k) => Value::String(k.clone()),
                Seg::I(i) => Value::from(*i),
            })
            .collect(),
    )
}

pub fn child(path: &[Seg], seg: impl Into<Seg>) -> Path {
    let mut p = path.to_vec();
    p.push(seg.into());
    p
}

/// Type reçu, tel que zod le nomme dans ses messages.
pub fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// Nombre affiché dans un message (`String(n)`).
fn n(x: f64) -> String {
    js::js_number_to_string(x)
}

fn num_json(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() <= MAX_SAFE_INTEGER {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// Liste d'issues, dans l'ordre où zod les produit.
#[derive(Debug, Default, Clone)]
pub struct Issues(pub Vec<Value>);

impl Issues {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn push(&mut self, mut issue: Map<String, Value>, path: &[Seg], message: String) {
        issue.insert("path".into(), path_json(path));
        issue.insert("message".into(), Value::String(message));
        self.0.push(Value::Object(issue));
    }

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    /// `invalid_type` : type attendu absent ou différent.
    pub fn invalid_type(&mut self, path: &[Seg], expected: &str, got: Option<&Value>) {
        let issue = Self::obj(json!({ "expected": expected, "code": "invalid_type" }));
        self.push(issue, path, format!("Invalid input: expected {expected}, received {}", received(got)));
    }

    /// `invalid_type` d'un nombre non fini (`NaN`, `Infinity`) après coercition.
    pub fn invalid_number(&mut self, path: &[Seg], x: f64) {
        let recu = if x.is_nan() { "NaN" } else { "Infinity" };
        let issue = Self::obj(json!({ "expected": "number", "code": "invalid_type", "received": recu }));
        let msg = if x.is_nan() { "received NaN" } else { "received number" };
        self.push(issue, path, format!("Invalid input: expected number, {msg}"));
    }

    /// `.int()` sur un nombre à décimales.
    pub fn not_int(&mut self, path: &[Seg]) {
        let issue = Self::obj(json!({ "expected": "int", "format": "safeint", "code": "invalid_type" }));
        self.push(issue, path, "Invalid input: expected int, received number".into());
    }

    /// `.int()` hors de l'intervalle des entiers sûrs.
    pub fn unsafe_int(&mut self, path: &[Seg], trop_grand: bool) {
        let (code, cle, borne, sens, op) = if trop_grand {
            ("too_big", "maximum", MAX_SAFE_INTEGER, "Too big", "<=")
        } else {
            ("too_small", "minimum", -MAX_SAFE_INTEGER, "Too small", ">=")
        };
        let mut issue = Map::new();
        issue.insert("code".into(), json!(code));
        issue.insert(cle.into(), num_json(borne));
        issue.insert("note".into(), json!("Integers must be within the safe integer range."));
        issue.insert("origin".into(), json!("int"));
        issue.insert("inclusive".into(), json!(true));
        self.push(issue, path, format!("{sens}: expected int to be {op}{}", n(borne)));
    }

    /// `too_small` (`origin` : `string`, `number` ou `array`).
    pub fn too_small(&mut self, path: &[Seg], origin: &str, minimum: f64, message: Option<&str>) {
        let mut issue = Map::new();
        issue.insert("origin".into(), json!(origin));
        issue.insert("code".into(), json!("too_small"));
        issue.insert("minimum".into(), num_json(minimum));
        issue.insert("inclusive".into(), json!(true));
        let defaut = match origin {
            "string" => format!("Too small: expected string to have >={} characters", n(minimum)),
            "array" => format!("Too small: expected array to have >={} items", n(minimum)),
            _ => format!("Too small: expected {origin} to be >={}", n(minimum)),
        };
        self.push(issue, path, message.map(str::to_string).unwrap_or(defaut));
    }

    /// `too_big` (`origin` : `string`, `number` ou `array`).
    pub fn too_big(&mut self, path: &[Seg], origin: &str, maximum: f64, message: Option<&str>) {
        let mut issue = Map::new();
        issue.insert("origin".into(), json!(origin));
        issue.insert("code".into(), json!("too_big"));
        issue.insert("maximum".into(), num_json(maximum));
        issue.insert("inclusive".into(), json!(true));
        let defaut = match origin {
            "string" => format!("Too big: expected string to have <={} characters", n(maximum)),
            "array" => format!("Too big: expected array to have <={} items", n(maximum)),
            _ => format!("Too big: expected {origin} to be <={}", n(maximum)),
        };
        self.push(issue, path, message.map(str::to_string).unwrap_or(defaut));
    }

    /// `invalid_value` d'un `z.enum([...])`.
    pub fn invalid_value(&mut self, path: &[Seg], values: &[&str], message: Option<&str>) {
        let issue = Self::obj(json!({ "code": "invalid_value", "values": values }));
        let defaut = format!("Invalid option: expected one of {}", values.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join("|"));
        self.push(issue, path, message.map(str::to_string).unwrap_or(defaut));
    }

    /// `invalid_format` d'un `.regex(...)`.
    pub fn invalid_regex(&mut self, path: &[Seg], pattern: &str, message: &str) {
        let issue = Self::obj(json!({ "origin": "string", "code": "invalid_format", "format": "regex", "pattern": pattern }));
        self.push(issue, path, message.to_string());
    }

    /// `custom` d'un `.refine(...)`.
    pub fn custom(&mut self, path: &[Seg], message: &str) {
        let issue = Self::obj(json!({ "code": "custom" }));
        self.push(issue, path, message.to_string());
    }

    /// Les issues, telles que `parsed.error.issues`.
    pub fn to_json(&self) -> Value {
        Value::Array(self.0.clone())
    }

    /// `parsed.error.message` : `JSON.stringify(issues, null, 2)`.
    pub fn message(&self) -> String {
        serde_json::to_string_pretty(&self.0).unwrap_or_default()
    }

    /// `issues.map((i) => i.message).join(", ")`.
    pub fn messages_joined(&self) -> String {
        self.0.iter().map(|i| i.get("message").and_then(Value::as_str).unwrap_or_default().to_string()).collect::<Vec<_>>().join(", ")
    }
}

// ---------------------------------------------------------------------------
// Briques de schéma
// ---------------------------------------------------------------------------

/// `z.object(...)` : la racine doit être un objet. `None` (issue posée) sinon.
pub fn object<'a>(v: Option<&'a Value>, path: &[Seg], issues: &mut Issues) -> Option<&'a Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        autre => {
            issues.invalid_type(path, "object", autre);
            None
        }
    }
}

/// `z.string()` obligatoire.
pub fn string(v: Option<&Value>, path: &[Seg], issues: &mut Issues) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        autre => {
            issues.invalid_type(path, "string", autre);
            None
        }
    }
}

/// `z.string().optional()` : `Ok(None)` si absent.
pub fn opt_string(v: Option<&Value>, path: &[Seg], issues: &mut Issues) -> Option<Option<String>> {
    match v {
        None => Some(None),
        autre => string(autre, path, issues).map(Some),
    }
}

/// `z.string().nullable()`.
pub fn nullable_string(v: Option<&Value>, path: &[Seg], issues: &mut Issues) -> Option<Option<String>> {
    match v {
        Some(Value::Null) => Some(None),
        autre => string(autre, path, issues).map(Some),
    }
}

/// Bornes de longueur d'une chaîne (`.min(n)`, `.max(n)`), en unités UTF-16 comme JS.
pub fn check_len(
    s: &str,
    path: &[Seg],
    min: Option<(usize, Option<&str>)>,
    max: Option<(usize, Option<&str>)>,
    issues: &mut Issues,
) -> bool {
    let len = s.encode_utf16().count();
    let mut ok = true;
    if let Some((m, msg)) = min {
        if len < m {
            issues.too_small(path, "string", m as f64, msg);
            ok = false;
        }
    }
    if let Some((m, msg)) = max {
        if len > m {
            issues.too_big(path, "string", m as f64, msg);
            ok = false;
        }
    }
    ok
}

/// `z.number()` (pas de coercition) : nombre fini.
pub fn number(v: Option<&Value>, path: &[Seg], issues: &mut Issues) -> Option<f64> {
    match v {
        Some(Value::Number(x)) => x.as_f64(),
        autre => {
            issues.invalid_type(path, "number", autre);
            None
        }
    }
}

/// `z.boolean()`.
pub fn boolean(v: Option<&Value>, path: &[Seg], issues: &mut Issues) -> Option<bool> {
    match v {
        Some(Value::Bool(b)) => Some(*b),
        autre => {
            issues.invalid_type(path, "boolean", autre);
            None
        }
    }
}

/// `z.enum([...])` sur une valeur quelconque.
pub fn enum_value(v: Option<&Value>, values: &[&str], path: &[Seg], message: Option<&str>, issues: &mut Issues) -> Option<String> {
    match v.and_then(Value::as_str) {
        Some(s) if values.contains(&s) => Some(s.to_string()),
        _ => {
            issues.invalid_value(path, values, message);
            None
        }
    }
}

/// `z.coerce.number().int().min(min)[.max(max)]` sur un paramètre d'URL.
pub fn coerce_int(s: &str, path: &[Seg], min: f64, max: Option<f64>, issues: &mut Issues) -> Option<i64> {
    let x = js::js_number_from_str(s);
    if !x.is_finite() {
        issues.invalid_number(path, x);
        return None;
    }
    if x.fract() != 0.0 {
        issues.not_int(path);
        return None;
    }
    let mut ok = true;
    if x > MAX_SAFE_INTEGER {
        issues.unsafe_int(path, true);
        ok = false;
    } else if x < -MAX_SAFE_INTEGER {
        issues.unsafe_int(path, false);
        ok = false;
    }
    if x < min {
        issues.too_small(path, "number", min, None);
        ok = false;
    }
    if let Some(m) = max {
        if x > m {
            issues.too_big(path, "number", m, None);
            ok = false;
        }
    }
    // `-0` reste un entier valide pour zod ; il ne peut de toute façon pas
    // franchir un minimum de 1.
    ok.then_some(x as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forme_des_issues() {
        let mut i = Issues::default();
        let p = vec![Seg::from("niveau")];
        assert!(coerce_int("abc", &p, 1.0, Some(3.0), &mut i).is_none());
        assert!(coerce_int("1e20", &p, 1.0, Some(3.0), &mut i).is_none());
        assert!(coerce_int("1.5", &p, 1.0, Some(3.0), &mut i).is_none());
        assert_eq!(coerce_int(" 0x2 ", &p, 1.0, Some(3.0), &mut i), Some(2));
        assert_eq!(
            serde_json::to_string(&i.to_json()).unwrap(),
            r#"[{"expected":"number","code":"invalid_type","received":"NaN","path":["niveau"],"message":"Invalid input: expected number, received NaN"},{"code":"too_big","maximum":9007199254740991,"note":"Integers must be within the safe integer range.","origin":"int","inclusive":true,"path":["niveau"],"message":"Too big: expected int to be <=9007199254740991"},{"origin":"number","code":"too_big","maximum":3,"inclusive":true,"path":["niveau"],"message":"Too big: expected number to be <=3"},{"expected":"int","format":"safeint","code":"invalid_type","path":["niveau"],"message":"Invalid input: expected int, received number"}]"#
        );
    }

    #[test]
    fn message_indente_comme_json_stringify() {
        let mut i = Issues::default();
        i.invalid_type(&[], "object", Some(&Value::Null));
        assert_eq!(
            i.message(),
            "[\n  {\n    \"expected\": \"object\",\n    \"code\": \"invalid_type\",\n    \"path\": [],\n    \"message\": \"Invalid input: expected object, received null\"\n  }\n]"
        );
    }
}
