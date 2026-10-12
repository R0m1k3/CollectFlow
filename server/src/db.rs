//! Pool PostgreSQL unique par processus, remplaçable à chaud.
//!
//! L'URL vient de `data/.db-config.json` (Paramètres), sinon de `DATABASE_URL`.
//! Enregistrer de nouveaux réglages appelle [`refresh`] : le pool suivant est
//! recréé à la première requête.
//!
//! La même base porte les tables de l'application et la recopie nocturne des
//! tables FF Nancy (`articles`, `mvtart`, `cube_stock`, `fouident`…).

use crate::error::{AppError, AppResult};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use parking_lot::RwLock;
use serde_json::{Map, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow};
use sqlx::{Column, Executor, PgPool, Row, TypeInfo, ValueRef};
use std::str::FromStr;
use std::sync::LazyLock;
use std::time::Duration;

static POOL: LazyLock<RwLock<Option<PgPool>>> = LazyLock::new(|| RwLock::new(None));

/// Masque le mot de passe d'une URL de connexion pour les journaux.
pub fn mask_url(url: &str) -> String {
    let re = regex::Regex::new(r":([^@/]+)@").unwrap();
    re.replace(url, ":****@").into_owned()
}

/// Options de connexion communes (pool applicatif et tests de connexion).
pub fn connect_options(url: &str) -> Result<PgConnectOptions, sqlx::Error> {
    let mut opts = PgConnectOptions::from_str(url)?.application_name("collectflow");
    // Délai maximal par requête : opt-in (les calculs nocturnes des plus gros
    // fournisseurs peuvent être longs).
    if let Some(ms) = std::env::var("PG_STATEMENT_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0) {
        opts = opts.options([("statement_timeout", ms.to_string())]);
    }
    Ok(opts)
}

fn build_pool(url: &str) -> Result<PgPool, sqlx::Error> {
    let opts = connect_options(url)?;
    Ok(PgPoolOptions::new()
        .max_connections(20)
        .idle_timeout(Duration::from_secs(30))
        .acquire_timeout(Duration::from_secs(10))
        // Pas de workers parallèles PostgreSQL : ils consomment /dev/shm, trop
        // petit dans le conteneur, et font échouer les grosses agrégations.
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                if let Err(e) = conn.execute("SET max_parallel_workers_per_gather = 0").await {
                    tracing::error!("[DB] SET max_parallel_workers_per_gather failed: {e}");
                }
                Ok(())
            })
        })
        .connect_lazy_with(opts))
}

/// Pool courant, créé à la demande. Erreur 500 si aucune base n'est configurée.
pub fn pool() -> AppResult<PgPool> {
    if let Some(p) = POOL.read().as_ref() {
        return Ok(p.clone());
    }
    let mut guard = POOL.write();
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    let url = crate::config::database_url().ok_or_else(|| {
        tracing::error!("[DB] CRITICAL: No database connection string available!");
        AppError::internal("Base de données non configurée (Paramètres → Base de données).")
    })?;
    tracing::info!("[DB] Initializing connection with: {}", mask_url(&url));
    let p = build_pool(&url).map_err(|e| AppError::internal(format!("URL de base invalide : {e}")))?;
    *guard = Some(p.clone());
    Ok(p)
}

/// Oublie le pool courant (réglages modifiés dans Paramètres).
pub fn refresh() {
    tracing::info!("[DB] Refreshing database connection...");
    if let Some(old) = POOL.write().take() {
        tokio::spawn(async move { old.close().await });
    }
}

// ---------------------------------------------------------------------------
// Conversion générique d'une ligne en JSON
// ---------------------------------------------------------------------------

/// Horodatage au format JS `toISOString()` (`2026-01-31T12:34:56.789Z`).
pub fn iso(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn iso_utc(dt: DateTime<Utc>) -> String {
    iso(dt.naive_utc())
}

/// Convertit une ligne en objet JSON, colonne par colonne, selon le type SQL.
///
/// Les `numeric` deviennent des nombres (le pilote Node les rendait en chaînes,
/// que le code convertissait avec `Number()`), les horodatages des chaînes ISO.
pub fn row_to_json(row: &PgRow) -> Value {
    let mut obj = Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        obj.insert(col.name().to_string(), cell_to_json(row, i));
    }
    Value::Object(obj)
}

pub fn rows_to_json(rows: &[PgRow]) -> Vec<Value> {
    rows.iter().map(row_to_json).collect()
}

fn cell_to_json(row: &PgRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    macro_rules! get {
        ($t:ty) => {
            row.try_get::<$t, _>(i).ok()
        };
    }
    let num = |f: Option<f64>| f.and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or(Value::Null);
    match ty.as_str() {
        "BOOL" => get!(bool).map(Value::Bool).unwrap_or(Value::Null),
        "INT2" => get!(i16).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "INT4" => get!(i32).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "INT8" => get!(i64).map(|v| Value::from(v)).unwrap_or(Value::Null),
        "FLOAT4" => num(get!(f32).map(|v| v as f64)),
        "FLOAT8" => num(get!(f64)),
        "NUMERIC" => num(get!(rust_decimal::Decimal).and_then(|d| d.to_string().parse::<f64>().ok())),
        "JSON" | "JSONB" => get!(Value).unwrap_or(Value::Null),
        "TIMESTAMP" => get!(NaiveDateTime).map(|d| Value::String(iso(d))).unwrap_or(Value::Null),
        "TIMESTAMPTZ" => get!(DateTime<Utc>).map(|d| Value::String(iso_utc(d))).unwrap_or(Value::Null),
        "DATE" => get!(NaiveDate)
            .map(|d| Value::String(iso(d.and_hms_opt(0, 0, 0).unwrap())))
            .unwrap_or(Value::Null),
        "TEXT[]" | "VARCHAR[]" | "_TEXT" | "_VARCHAR" => get!(Vec<String>).map(Value::from).unwrap_or(Value::Null),
        _ => get!(String).map(Value::String).unwrap_or(Value::Null),
    }
}

// ---------------------------------------------------------------------------
// Lecture tolérante de colonnes (équivalent des `Number(r.x) || 0` du code TS)
// ---------------------------------------------------------------------------

/// Valeur numérique d'une colonne quel que soit son type SQL (int, numeric,
/// float, texte numérique). `None` si NULL ou illisible.
pub fn get_f64(row: &PgRow, col: &str) -> Option<f64> {
    let raw = row.try_get_raw(col).ok()?;
    if raw.is_null() {
        return None;
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    match ty.as_str() {
        "INT2" => row.try_get::<i16, _>(col).ok().map(|v| v as f64),
        "INT4" => row.try_get::<i32, _>(col).ok().map(|v| v as f64),
        "INT8" => row.try_get::<i64, _>(col).ok().map(|v| v as f64),
        "FLOAT4" => row.try_get::<f32, _>(col).ok().map(|v| v as f64),
        "FLOAT8" => row.try_get::<f64, _>(col).ok(),
        "NUMERIC" => row
            .try_get::<rust_decimal::Decimal, _>(col)
            .ok()
            .and_then(|d| d.to_string().parse::<f64>().ok()),
        _ => row.try_get::<String, _>(col).ok().and_then(|s| s.trim().parse::<f64>().ok()),
    }
    .filter(|v| v.is_finite())
}

/// `Number(r.col) || 0`.
pub fn f64_or0(row: &PgRow, col: &str) -> f64 {
    get_f64(row, col).unwrap_or(0.0)
}

/// Valeur texte d'une colonne quel que soit son type (nombres et dates convertis).
pub fn get_string(row: &PgRow, col: &str) -> Option<String> {
    let idx = row.columns().iter().position(|c| c.name() == col)?;
    match cell_to_json(row, idx) {
        Value::Null => None,
        Value::String(s) => Some(s),
        Value::Number(n) => {
            // 12.0 → "12", comme String(12) en JS.
            let f = n.as_f64().unwrap_or_default();
            if f.fract() == 0.0 && f.abs() < 1e15 {
                Some(format!("{}", f as i64))
            } else {
                Some(n.to_string())
            }
        }
        other => Some(other.to_string()),
    }
}

/// `String(r.col ?? "")`.
pub fn string_or_empty(row: &PgRow, col: &str) -> String {
    get_string(row, col).unwrap_or_default()
}
