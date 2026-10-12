//! Cache des métriques réseau Qlik, table `qlik_network_metrics`
//! (port de `src/lib/qlik-network-cache.ts`).
//!
//! Lecture par lot (jointure grille) + upsert en masse (route de sync).

use super::client::{NetworkMetric, QlikMonthMetrics};
use super::jsnum;
use crate::db;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetricCached {
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub ca_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub qte_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub nb_magasins_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub ca_par_magasin_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub marge_pct_reseau: f64,
    /// Quantité réseau par mois : { "YYYY-MM": qté } — null si non synchronisé avec dates.
    #[serde(serialize_with = "jsnum::ser_map", deserialize_with = "jsnum::de_map")]
    pub qte_by_month: Option<BTreeMap<String, f64>>,
    /// Détail mensuel complet : { "YYYY-MM": { qte, ca, nbMag, caMag, margePct } }.
    /// null pour les lignes synchronisées avant l'ajout de la colonne — l'UI
    /// retombe alors sur `qteByMonth`.
    pub metrics_by_month: Option<BTreeMap<String, QlikMonthMetrics>>,
    /// Période couverte par l'extraction (ex "2025-03_2026-02").
    pub periode: Option<String>,
    /// Libellé de l'article côté Qlik — `null` tant qu'aucune recherche produit ne l'a renseigné.
    pub libelle_reseau: Option<String>,
    /// Fournisseur de l'article côté Qlik, même origine que `libelle_reseau`.
    pub fournisseur_reseau: Option<String>,
    pub fetched_at: Option<String>,
}

/// Lit les métriques réseau pour une liste de codes centraux.
///
/// La `HashMap` se sérialise comme l'objet `Object.fromEntries(map)` du TS.
pub async fn get_network_metrics_by_code_centrale(codes: &[String]) -> anyhow::Result<HashMap<String, NetworkMetricCached>> {
    let mut out = HashMap::new();
    let mut vus = HashSet::new();
    let uniques: Vec<String> = codes.iter().filter(|c| !c.is_empty() && vus.insert(c.as_str())).cloned().collect();
    if uniques.is_empty() {
        return Ok(out);
    }
    let pool = db::pool().map_err(|e| anyhow::anyhow!(e.message))?;

    // Découpage conservé du TS : `inArray` y produisait un paramètre lié par
    // valeur, or le protocole PostgreSQL en accepte 65535 au maximum — un gros
    // fournisseur dépasse 130 000 codes. (Ici un seul tableau lié par lot.)
    const CHUNK: usize = 2000;
    for lot in uniques.chunks(CHUNK) {
        let rows = sqlx::query(
            r#"SELECT "code_centrale", "ca_reseau", "qte_reseau", "nb_magasins_reseau", "ca_par_magasin_reseau",
                      "marge_pct_reseau", "periode", "qte_by_month", "metrics_by_month", "libelle_reseau",
                      "fournisseur_reseau", "fetched_at"
               FROM "qlik_network_metrics" WHERE "code_centrale" = ANY($1)"#,
        )
        .bind(lot)
        .fetch_all(&pool)
        .await?;
        for r in rows {
            let code: String = r.try_get("code_centrale")?;
            let json = |col: &str| r.try_get::<Option<serde_json::Value>, _>(col).ok().flatten();
            let qte_by_month = json("qte_by_month").and_then(|v| match v {
                serde_json::Value::Object(m) => Some(m.iter().map(|(k, x)| (k.clone(), jsnum::nombre(x))).collect()),
                _ => None,
            });
            let metrics_by_month = json("metrics_by_month").and_then(|v| serde_json::from_value(v).ok());
            let fetched_at = r.try_get::<Option<chrono::NaiveDateTime>, _>("fetched_at").ok().flatten().map(db::iso);
            out.insert(
                code,
                NetworkMetricCached {
                    ca_reseau: db::f64_or0(&r, "ca_reseau"),
                    qte_reseau: db::f64_or0(&r, "qte_reseau"),
                    nb_magasins_reseau: db::f64_or0(&r, "nb_magasins_reseau"),
                    ca_par_magasin_reseau: db::f64_or0(&r, "ca_par_magasin_reseau"),
                    marge_pct_reseau: db::f64_or0(&r, "marge_pct_reseau"),
                    qte_by_month,
                    metrics_by_month,
                    periode: r.try_get("periode").ok().flatten(),
                    libelle_reseau: r.try_get("libelle_reseau").ok().flatten(),
                    fournisseur_reseau: r.try_get("fournisseur_reseau").ok().flatten(),
                    fetched_at,
                },
            );
        }
    }
    Ok(out)
}

/// Upsert en masse des métriques réseau (depuis Qlik). Renvoie le nombre de lignes envoyées.
pub async fn upsert_network_metrics(metrics: &[NetworkMetric]) -> anyhow::Result<usize> {
    if metrics.is_empty() {
        return Ok(0);
    }
    let pool = db::pool().map_err(|e| anyhow::anyhow!(e.message))?;
    let now = chrono::Utc::now().naive_utc();

    // Upsert par paquets pour éviter les requêtes trop volumineuses.
    const CHUNK: usize = 500;
    let mut count = 0;
    for lot in metrics.chunks(CHUNK) {
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            r#"INSERT INTO "qlik_network_metrics" ("code_centrale", "ca_reseau", "qte_reseau", "nb_magasins_reseau",
                "ca_par_magasin_reseau", "marge_pct_reseau", "periode", "qte_by_month", "metrics_by_month",
                "libelle_reseau", "fournisseur_reseau", "fetched_at") "#,
        );
        qb.push_values(lot, |mut b, m| {
            let qte_by_month =
                m.qte_by_month.as_ref().map(|q| serde_json::Value::Object(q.iter().map(|(k, v)| (k.clone(), jsnum::valeur(*v))).collect()));
            let metrics_by_month = m.metrics_by_month.as_ref().and_then(|x| serde_json::to_value(x).ok());
            // Les nombres passent en texte vers `numeric`, comme `String(m.caReseau)` côté TS.
            b.push_bind(m.code_centrale.clone())
                .push_bind(jsnum::texte(m.ca_reseau))
                .push_unseparated("::numeric")
                .push_bind(jsnum::texte(m.qte_reseau))
                .push_unseparated("::numeric")
                .push_bind(m.nb_magasins_reseau)
                .push_unseparated("::float8::integer")
                .push_bind(jsnum::texte(m.ca_par_magasin_reseau))
                .push_unseparated("::numeric")
                .push_bind(jsnum::texte(m.marge_pct_reseau))
                .push_unseparated("::numeric")
                .push_bind(m.periode.clone())
                .push_bind(qte_by_month)
                .push_unseparated("::jsonb")
                .push_bind(metrics_by_month)
                .push_unseparated("::jsonb")
                .push_bind(m.libelle_reseau.clone())
                .push_bind(m.fournisseur_reseau.clone())
                .push_bind(now);
        });
        qb.push(
            r#" ON CONFLICT ("code_centrale") DO UPDATE SET
                "ca_reseau" = excluded.ca_reseau,
                "qte_reseau" = excluded.qte_reseau,
                "nb_magasins_reseau" = excluded.nb_magasins_reseau,
                "ca_par_magasin_reseau" = excluded.ca_par_magasin_reseau,
                "marge_pct_reseau" = excluded.marge_pct_reseau,
                "periode" = excluded.periode,
                "qte_by_month" = COALESCE(excluded.qte_by_month, "qlik_network_metrics"."qte_by_month"),
                "metrics_by_month" = COALESCE(excluded.metrics_by_month, "qlik_network_metrics"."metrics_by_month"),
                "libelle_reseau" = COALESCE(excluded.libelle_reseau, "qlik_network_metrics"."libelle_reseau"),
                "fournisseur_reseau" = COALESCE(excluded.fournisseur_reseau, "qlik_network_metrics"."fournisseur_reseau"),
                "fetched_at" = excluded.fetched_at"#,
        );
        // Le détail mensuel n'est produit que par l'extraction complète
        // (dimension Mois). La recherche produit, elle, n'a que les agrégats :
        // elle ne doit pas effacer un mensuel déjà extrait (COALESCE ci-dessus).
        // Seule la recherche produit connaît le libellé / le fournisseur réseau :
        // une sync fournisseur ne doit pas les effacer.
        qb.build().execute(&pool).await?;
        count += lot.len();
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    //! Contre la base locale : `DATABASE_URL=postgres://postgres:postgres@localhost/collectflow
    //! cargo test -- --ignored cache_reseau`.
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn cache_reseau_upsert_et_lecture() {
        if std::env::var("DATABASE_URL").is_err() {
            std::env::set_var("DATABASE_URL", "postgres://postgres:postgres@localhost/collectflow");
        }
        let code = format!("TEST{}", rand::random::<u32>() % 1_000_000);
        let mut m = NetworkMetric {
            code_centrale: code.clone(),
            ca_reseau: 1234.567,
            qte_reseau: 42.0,
            nb_magasins_reseau: 12.0,
            ca_par_magasin_reseau: 102.88,
            marge_pct_reseau: 0.3215,
            periode: Some("2025-10_2026-09".into()),
            qte_by_month: Some(BTreeMap::from([("2026-08".into(), 20.0), ("2026-09".into(), 22.0)])),
            metrics_by_month: Some(BTreeMap::from([(
                "2026-09".into(),
                QlikMonthMetrics { qte: 22.0, ca: Some(600.5), nb_mag: Some(7.0), ca_mag: Some(85.78), marge_pct: Some(0.31) },
            )])),
            libelle_reseau: Some("TAPIS ANTIDERAPANT".into()),
            fournisseur_reseau: None,
        };
        assert_eq!(upsert_network_metrics(std::slice::from_ref(&m)).await.unwrap(), 1);

        // Une sync sans mensuel ni libellé ne doit pas effacer ceux déjà connus.
        m.qte_by_month = None;
        m.metrics_by_month = None;
        m.libelle_reseau = None;
        m.qte_reseau = 50.0;
        upsert_network_metrics(std::slice::from_ref(&m)).await.unwrap();

        let lu = get_network_metrics_by_code_centrale(&[code.clone(), code.clone(), String::new()]).await.unwrap();
        let c = &lu[&code];
        assert_eq!(c.ca_reseau, 1234.57);
        assert_eq!(c.qte_reseau, 50.0);
        assert_eq!(c.nb_magasins_reseau, 12.0);
        assert_eq!(c.marge_pct_reseau, 0.3215);
        assert_eq!(c.qte_by_month.as_ref().unwrap()["2026-09"], 22.0);
        assert_eq!(c.metrics_by_month.as_ref().unwrap()["2026-09"].nb_mag, Some(7.0));
        assert_eq!(c.libelle_reseau.as_deref(), Some("TAPIS ANTIDERAPANT"));
        assert!(c.fetched_at.as_deref().unwrap().ends_with('Z'));
        let json = serde_json::to_string(c).unwrap();
        assert!(json.contains(r#""qteByMonth":{"2026-08":20,"2026-09":22}"#), "{json}");
        assert!(json.contains(r#""fournisseurReseau":null"#), "{json}");

        let pool = db::pool().unwrap();
        sqlx::query("DELETE FROM qlik_network_metrics WHERE code_centrale = $1").bind(&code).execute(&pool).await.unwrap();
    }
}
