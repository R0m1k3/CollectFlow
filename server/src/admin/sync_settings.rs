//! Réglages de la synchronisation nocturne, rangés dans `data/.db-config.json`
//! (clé `syncNuit`) comme les autres réglages de l'application.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    /// Désactivé par défaut : un déploiement ne doit pas se mettre à solliciter
    /// Qlik et la base la nuit suivante sans que personne l'ait décidé.
    pub actif: bool,
    /// Heure d'ouverture de la fenêtre (0-23).
    pub heure_debut: i64,
    /// Heure de fermeture. Aucun fournisseur n'est **démarré** après.
    pub heure_fin: i64,
    /// Nombre maximum d'extractions Qlik par nuit (chacune peut prendre 8 min).
    pub qlik_par_nuit: i64,
    /// Une extraction Qlik est intercalée tous les N fournisseurs SQL.
    pub sql_par_qlik: i64,
    /// Âge minimal des données Qlik avant de les refaire.
    pub qlik_min_jours: i64,
}

pub const SYNC_SETTINGS_DEFAUT: SyncSettings =
    SyncSettings { actif: false, heure_debut: 0, heure_fin: 5, qlik_par_nuit: 6, sql_par_qlik: 20, qlik_min_jours: 7 };

fn borne(v: Option<&Value>, min: i64, max: i64, defaut: i64) -> i64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Null) => Some(0.0),
        _ => None,
    };
    match n {
        Some(f) if f.is_finite() => (f.trunc() as i64).clamp(min, max),
        _ => defaut,
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Normalise ce qui vient du fichier : il est éditable à la main.
pub fn normaliser(brut: Option<&Map<String, Value>>) -> SyncSettings {
    let d = SYNC_SETTINGS_DEFAUT;
    let g = |k: &str| brut.and_then(|m| m.get(k));
    let mut s = SyncSettings {
        actif: truthy(g("actif")),
        heure_debut: borne(g("heureDebut"), 0, 23, d.heure_debut),
        heure_fin: borne(g("heureFin"), 0, 23, d.heure_fin),
        qlik_par_nuit: borne(g("qlikParNuit"), 0, 200, d.qlik_par_nuit),
        sql_par_qlik: borne(g("sqlParQlik"), 1, 500, d.sql_par_qlik),
        qlik_min_jours: borne(g("qlikMinJours"), 0, 365, d.qlik_min_jours),
    };
    // Une fenêtre de durée nulle ne s'ouvrirait jamais : retour au défaut.
    if s.heure_debut == s.heure_fin {
        s.heure_debut = d.heure_debut;
        s.heure_fin = d.heure_fin;
    }
    s
}

fn lire_fichier() -> Option<Map<String, Value>> {
    let raw = std::fs::read_to_string(crate::config::config_file()).ok()?;
    match serde_json::from_str::<Value>(&raw).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

pub fn read_sync_settings() -> SyncSettings {
    match lire_fichier() {
        Some(cfg) => normaliser(cfg.get("syncNuit").and_then(|v| v.as_object())),
        None => SYNC_SETTINGS_DEFAUT,
    }
}

/// Fusionne `patch` (champs camelCase partiels) dans les réglages enregistrés.
pub fn save_sync_settings(patch: &Map<String, Value>) -> std::io::Result<SyncSettings> {
    let existant = lire_fichier().unwrap_or_default();
    let courant = normaliser(existant.get("syncNuit").and_then(|v| v.as_object()));
    let mut fusion = match serde_json::to_value(courant) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    for (k, v) in patch {
        fusion.insert(k.clone(), v.clone());
    }
    let suivant = normaliser(Some(&fusion));
    let mut p = Map::new();
    p.insert("syncNuit".into(), serde_json::to_value(suivant).unwrap_or(Value::Null));
    crate::config::write_config(p)?;
    tracing::info!("[sync-nuit] réglages enregistrés : {}", serde_json::to_string(&suivant).unwrap_or_default());
    Ok(suivant)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalise() {
        let m = json!({ "actif": 1, "heureDebut": "2", "heureFin": 30, "qlikParNuit": -4, "sqlParQlik": 0 });
        let s = normaliser(m.as_object());
        assert!(s.actif);
        assert_eq!((s.heure_debut, s.heure_fin, s.qlik_par_nuit, s.sql_par_qlik, s.qlik_min_jours), (2, 23, 0, 1, 7));
        let m = json!({ "heureDebut": 4, "heureFin": 4 });
        let s = normaliser(m.as_object());
        assert_eq!((s.heure_debut, s.heure_fin), (0, 5));
    }
}
