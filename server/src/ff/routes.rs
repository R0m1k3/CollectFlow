//! Routes HTTP du module FF : `/api/ff-status`, `/api/diag`,
//! `/api/diag/stock-fournisseur`, `/api/test-db`, `/api/commandes-auto`.

use super::api::{ff_client, get_ff_api_base};
use super::diagnostic::diagnostiquer_api_ff;
use super::js::{encode, js_string, message_erreur};
use super::pg::{pg_diag_fournisseur_derniere_entree, pg_get_stock_for_codeins};
use crate::auth::{AdminUser, SessionUser};
use crate::db::{pool, rows_to_json};
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Datelike, Local, NaiveDate};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// `String(e)` d'une erreur JS (`Error: message`).
fn string_erreur(e: &dyn std::fmt::Display) -> String {
    format!("Error: {e}")
}

// ---------------------------------------------------------------------------
// GET /api/ff-status
// ---------------------------------------------------------------------------

/// GET /api/ff-status — état de l'API REST FF Nancy.
///
/// S'appuie sur le même diagnostic que le bouton « Tester » des Paramètres, afin
/// qu'un échec dise *pourquoi* (DNS, connexion refusée, délai dépassé, code HTTP)
/// et *quelle adresse* a été appelée. L'ancienne version renvoyait un 503 sans
/// détail, impossible à distinguer d'une simple erreur d'URL.
pub async fn ff_status(_user: SessionUser) -> Response {
    let res = diagnostiquer_api_ff(None).await;
    if !res.success {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "API FF Nancy non disponible", "url": res.url, "detail": res.error })),
        )
            .into_response();
    }
    Json(res.status).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/diag/stock-fournisseur
// ---------------------------------------------------------------------------

/// Diagnostic de l'attribution « fournisseur de la dernière entrée » utilisée par
/// la page Gestion de Stock.
///
/// `colonneDetectee: null` signifie que `mvtart` ne porte aucune des colonnes
/// fournisseur connues : la page retombe alors sur `artfou1.preference = 1`.
/// `colonnesMvtart` liste ce qui existe réellement, pour compléter la liste
/// blanche `MVTART_FOU_CANDIDATES` si le nom diffère.
pub async fn diag_stock_fournisseur(_admin: AdminUser) -> Response {
    match pg_diag_fournisseur_derniere_entree().await {
        Ok(d) => Json(d).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": string_erreur(&message_erreur(&e)) }))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /api/test-db
// ---------------------------------------------------------------------------

pub async fn test_db(_admin: AdminUser, Query(q): Query<HashMap<String, String>>) -> Response {
    let codein = q.get("codein").filter(|c| !c.is_empty()).cloned().unwrap_or_else(|| "334152".into());
    let res = async {
        let map = pg_get_stock_for_codeins(std::slice::from_ref(&codein)).await?;
        let fou = sqlx::query(
            r#"
            SELECT
                a.codein::text AS codein,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur
            FROM articles a
            LEFT JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
            LEFT JOIN fouident fi ON fi.code = af.code
            WHERE a.codein::text = $1
        "#,
        )
        .bind(&codein)
        .fetch_all(&pool()?)
        .await?;
        let stock: Map<String, Value> = map.into_iter().map(|(k, v)| (k, serde_json::to_value(v).unwrap_or(Value::Null))).collect();
        anyhow::Ok(json!({ "stock": stock, "fou": rows_to_json(&fou) }))
    }
    .await;
    match res {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            // Pas de pile d'appels dans la réponse : elle reste dans les journaux du serveur.
            tracing::error!("[api/test-db] {}", message_erreur(&e));
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": message_erreur(&e) }))).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/commandes-auto
// ---------------------------------------------------------------------------

/// GET /api/commandes-auto[?site=292&codefou=N009]
///
/// Proxy vers https://api.ffnancy.fr/api/commandes-auto
/// Transfère les query params site et codefou si présents.
pub async fn commandes_auto(_user: SessionUser, Query(q): Query<HashMap<String, String>>) -> Response {
    let res = async {
        let mut params: Vec<(&str, &str)> = vec![];
        if let Some(site) = q.get("site").filter(|s| !s.is_empty()) {
            params.push(("site", site));
        }
        if let Some(codefou) = q.get("codefou").filter(|s| !s.is_empty()) {
            params.push(("codefou", codefou));
        }
        let base = get_ff_api_base().await;
        let url = format!("{base}/api/commandes-auto");
        let res = ff_client().get(&url).query(&params).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            return anyhow::Ok(
                (status, Json(json!({ "error": format!("API upstream HTTP {}", status.as_u16()) }))).into_response(),
            );
        }
        let data: Value = res.json().await?;
        Ok(Json(data).into_response())
    }
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[api/commandes-auto] {}", message_erreur(&e));
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Erreur serveur" }))).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/diag
// ---------------------------------------------------------------------------

/// Résumé d'une sonde : statut HTTP et aperçu du contenu.
async fn probe(url: String) -> Value {
    let res = async {
        let res = reqwest::Client::new().get(&url).header(reqwest::header::CACHE_CONTROL, "no-store").send().await?;
        let status = res.status().as_u16();
        let text = res.text().await?;
        anyhow::Ok((status, text))
    }
    .await;
    let (status, text) = match res {
        Ok(v) => v,
        Err(e) => return json!({ "error": string_erreur(&message_erreur(&e)), "url": url }),
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.chars().take(800).collect()));
    let keys_of = |v: Option<&Value>| -> Value {
        match v.and_then(|x| x.as_object()) {
            Some(o) => Value::from(o.keys().cloned().collect::<Vec<_>>()),
            None => json!([]),
        }
    };
    let summary = match &parsed {
        Value::Array(a) => json!({ "count": a.len(), "firstKeys": keys_of(a.first()), "sample": a.iter().take(2).cloned().collect::<Vec<_>>() }),
        Value::Object(o) => {
            let keys: Vec<String> = o.keys().cloned().collect();
            match o.iter().find(|(_, v)| v.is_array()) {
                Some((k, Value::Array(arr))) => json!({
                    "wrapper": k,
                    "count": arr.len(),
                    "firstKeys": keys_of(arr.first()),
                    "sample": arr.iter().take(2).cloned().collect::<Vec<_>>(),
                }),
                // Objet simple : montrer toutes les clés et le contenu complet
                _ => json!({ "keys": keys, "full": parsed }),
            }
        }
        other => other.clone(),
    };
    json!({ "status": status, "url": url, "summary": summary })
}

/// Première liste d'une réponse : tableau direct ou première propriété tableau.
fn premiere_liste(data: &Value) -> Vec<Value> {
    match data {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o.values().find_map(|v| v.as_array().cloned()).unwrap_or_default(),
        _ => vec![],
    }
}

async fn get_json(url: &str) -> anyhow::Result<Value> {
    let res = reqwest::Client::new().get(url).header(reqwest::header::CACHE_CONTROL, "no-store").send().await?;
    Ok(res.json::<Value>().await?)
}

/// Champ texte d'un élément (`(x as Record).champ as string ?? null`).
fn champ(v: Option<&Value>, key: &str) -> Option<String> {
    v.and_then(|x| x.get(key)).filter(|x| !x.is_null()).map(js_string)
}

pub async fn diag(_admin: AdminUser, Query(q): Query<HashMap<String, String>>) -> Response {
    let ff_api_base = get_ff_api_base().await;

    // Date range: 12 derniers mois
    let today = Local::now().date_naive();
    let first = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
    let date_fin = first.pred_opt().unwrap_or(first).format("%Y-%m-%d").to_string();
    let date_debut = first.checked_sub_months(chrono::Months::new(12)).unwrap_or(first).format("%Y-%m-%d").to_string();

    // Récupérer un codefou réel + un codein réel depuis l'API
    let mut codefou: Option<String> = q.get("codefou").filter(|s| !s.is_empty()).cloned();
    let mut first_codein: Option<String> = q.get("codein").filter(|s| !s.is_empty()).cloned();
    let forced_noid: Option<String> = q.get("noid").filter(|s| !s.is_empty()).cloned(); // ex: ?noid=129632

    if codefou.is_none() {
        if let Ok(data) = get_json(&format!("{ff_api_base}/api/fournisseurs?limit=1")).await {
            let list = premiere_liste(&data);
            codefou = champ(list.first(), "codefou");
        }
        if codefou.is_none() {
            codefou = Some("D005".into());
        }
    }
    let codefou = codefou.unwrap_or_default();
    let codefou_enc = encode(&codefou);

    if first_codein.is_none() {
        if let Ok(data) = get_json(&format!("{ff_api_base}/api/articles?codefou={codefou_enc}&limit=1")).await {
            let list = premiere_liste(&data);
            first_codein = champ(list.first(), "codein");
        }
    }

    // Si un noid est forcé, on probe directement mensuel + referentiel pour cet article
    let mensuel_noid_forced = async {
        match &forced_noid {
            Some(n) => {
                probe(format!("{ff_api_base}/api/articles/{}/mensuel?dateDebut={date_debut}&dateFin={date_fin}", encode(n))).await
            }
            None => json!({ "skipped": "no ?noid= param" }),
        }
    };
    let referentiel_noid_forced = async {
        match &forced_noid {
            Some(n) => probe(format!("{ff_api_base}/api/articles/{}/referentiel", encode(n))).await,
            None => json!({ "skipped": "no ?noid= param" }),
        }
    };
    // Test mensuel avec no_id auto-résolu
    let mensuel_noid = async {
        if first_codein.is_none() {
            return json!({ "skipped": "no article" });
        }
        if let Ok(data) = get_json(&format!("{ff_api_base}/api/articles?codefou={codefou_enc}&limit=1")).await {
            let list = premiere_liste(&data);
            if let Some(noid) = champ(list.first(), "no_id").filter(|s| !s.is_empty()) {
                return probe(format!(
                    "{ff_api_base}/api/articles/{}/mensuel?dateDebut={date_debut}&dateFin={date_fin}",
                    encode(&noid)
                ))
                .await;
            }
        }
        json!({ "skipped": "no no_id available" })
    };
    // Referentiel complet (nomenclature + gamme + stock + prix)
    let referentiel = async {
        if first_codein.is_none() {
            return json!({ "skipped": "no codefou" });
        }
        if let Ok(data) = get_json(&format!("{ff_api_base}/api/articles?codefou={codefou_enc}&limit=5")).await {
            let list = premiere_liste(&data);
            let art = list.get(4).or(list.first());
            if let Some(no_id) = champ(art, "no_id").filter(|s| !s.is_empty()) {
                return probe(format!("{ff_api_base}/api/articles/{}/referentiel", encode(&no_id))).await;
            }
        }
        json!({ "skipped": "no no_id" })
    };

    let (fournisseurs, articles, mvt_date_debut, mensuel_noid, referentiel, mensuel_forced, referentiel_forced) = tokio::join!(
        probe(format!("{ff_api_base}/api/fournisseurs?limit=2")),
        probe(format!("{ff_api_base}/api/articles?codefou={codefou_enc}&limit=2")),
        probe(format!(
            "{ff_api_base}/api/mouvements/articles?codefou={codefou_enc}&dateDebut={date_debut}&dateFin={date_fin}&limit=2"
        )),
        mensuel_noid,
        referentiel,
        mensuel_noid_forced,
        referentiel_noid_forced,
    );

    // Test PostgreSQL + diagnostic ventesProduits
    let (postgresql, ventes_produits_diag) = match async {
        let pool = pool()?;
        let r = sqlx::query("SELECT COUNT(*) as count FROM session_snapshots").fetch_all(&pool).await?;

        // Diagnostic ventesProduits : cherche par les 2 codes possibles d'AUXENCE
        let vp_by_name = sqlx::query(
            r#"
            SELECT code_fournisseur, COUNT(*) as nb_rows,
                   COUNT(code_gamme) as nb_gamme,
                   COUNT(code_gamme_init) as nb_gamme_init,
                   COUNT(code3) as nb_code3
            FROM ventes_produits
            WHERE code_fournisseur IN ('AUXENCE', 'A025', $1)
            GROUP BY code_fournisseur
        "#,
        )
        .bind(&codefou)
        .fetch_all(&pool)
        .await?;

        // Sample de quelques codeins dans ventesProduits pour ce fournisseur
        let vp_sample = sqlx::query(
            r#"
            SELECT codein, code_fournisseur, code_gamme, code_gamme_init, code3, libelle3
            FROM ventes_produits
            WHERE code_fournisseur IN ('AUXENCE', 'A025', $1)
            LIMIT 3
        "#,
        )
        .bind(&codefou)
        .fetch_all(&pool)
        .await?;

        let snapshots = r.first().map(|row| crate::db::f64_or0(row, "count")).unwrap_or(0.0);
        anyhow::Ok((
            json!({ "ok": true, "snapshots": snapshots }),
            json!({ "byFournisseur": rows_to_json(&vp_by_name), "sample": rows_to_json(&vp_sample) }),
        ))
    }
    .await
    {
        Ok(v) => v,
        Err(e) => {
            let msg = string_erreur(&message_erreur(&e));
            (json!({ "ok": false, "error": msg }), json!({ "error": msg }))
        }
    };

    // Diagnostic analytics CA TTC
    let mvtart_diag = match async {
        let pool = pool()?;
        // 1. Totaux mars 2025 avec mntmvtht et mntmvtttc pour comparer avec API (HT=225k, TTC=269k)
        let totaux = sqlx::query(
            r#"
            SELECT site,
                   ABS(SUM(mntmvtht))::float   AS sum_ht,
                   ABS(SUM(mntmvtttc))::float  AS sum_ttc,
                   COUNT(*) AS nb_lignes
            FROM mvtart
            WHERE genremvt = 3
              AND TO_CHAR(datmvt, 'YYYY-MM') = '2025-03'
              AND site IN ('292', '579')
            GROUP BY site
        "#,
        )
        .fetch_all(&pool)
        .await?;
        // 2. Distribution des valeurs de preference dans artfou1
        let pref_dist = sqlx::query(
            r#"
            SELECT preference, COUNT(*) AS nb
            FROM artfou1
            GROUP BY preference
            ORDER BY preference
        "#,
        )
        .fetch_all(&pool)
        .await?;
        // 3. Ventes mars 2025 non attribuées (aucune ligne artfou1 avec preference=1)
        let sans_preference = sqlx::query(
            r#"
            SELECT COUNT(DISTINCT m.artnoid) AS nb_articles_sans_pref
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            WHERE m.genremvt = 3
              AND TO_CHAR(m.datmvt, 'YYYY-MM') = '2025-03'
              AND m.site IN ('292','579')
              AND NOT EXISTS (
                  SELECT 1 FROM artfou1 af
                  WHERE af.art_no_id = a.no_id AND af.preference = 1
              )
        "#,
        )
        .fetch_all(&pool)
        .await?;
        anyhow::Ok(json!({
            "totaux_202503": rows_to_json(&totaux),
            "artfou1_preference_distribution": rows_to_json(&pref_dist),
            "articles_vendus_sans_pref1": rows_to_json(&sans_preference),
        }))
    }
    .await
    {
        Ok(v) => v,
        Err(e) => json!({ "error": string_erreur(&message_erreur(&e)) }),
    };

    // Diagnostic franco : colonnes DB avec "franco" + sample fouident + raw commandes-auto
    let franco_diag = match async {
        let pool = pool()?;
        let franco_columns = sqlx::query(
            r#"
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE column_name ILIKE '%franco%'
               OR column_name ILIKE '%min_cmd%'
               OR column_name ILIKE '%mincde%'
               OR column_name ILIKE '%min_commande%'
            ORDER BY table_name, column_name
        "#,
        )
        .fetch_all(&pool)
        .await?;
        // Sample des 3 premières lignes de fouident pour voir toutes les colonnes
        let fouident_sample = rows_to_json(&sqlx::query("SELECT * FROM fouident LIMIT 3").fetch_all(&pool).await?);
        let foucad_sample = rows_to_json(&sqlx::query("SELECT * FROM foucad LIMIT 5").fetch_all(&pool).await?);
        let cols = |rows: &[Value]| -> Value {
            match rows.first().and_then(|r| r.as_object()) {
                Some(o) => Value::from(o.keys().cloned().collect::<Vec<_>>()),
                None => json!([]),
            }
        };
        anyhow::Ok(json!({
            "francoColumns": rows_to_json(&franco_columns),
            "fouidentColumns": cols(&fouident_sample),
            "fouidentSample": fouident_sample,
            "foucadColumns": cols(&foucad_sample),
            "foucadSample": foucad_sample,
        }))
    }
    .await
    {
        Ok(v) => v,
        Err(e) => json!({ "error": string_erreur(&message_erreur(&e)) }),
    };

    // Raw commandes-auto : récupère toutes les lignes et filtre celles avec franco_ht manquant
    let commandes_auto_franco_audit = match get_json(&format!("{ff_api_base}/api/commandes-auto")).await {
        Ok(ca_data) => {
            let ca_rows: Vec<Value> = match &ca_data {
                Value::Array(a) => a.clone(),
                d => d
                    .get("propositions")
                    .filter(|v| !v.is_null())
                    .or_else(|| d.get("data").filter(|v| !v.is_null()))
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default(),
            };
            let franco = |r: &Value| r.get("franco_ht").filter(|v| !v.is_null()).map(super::js::js_number);
            let with_franco = ca_rows.iter().filter(|r| franco(r).map(|f| f > 0.0).unwrap_or(false)).count();
            let without: Vec<&Value> = ca_rows.iter().filter(|r| franco(r).map(|f| f == 0.0).unwrap_or(true)).collect();
            json!({
                "total": ca_rows.len(),
                "avecFranco": with_franco,
                "sansFranco": without.len(),
                "lignesSansFranco": without.iter().map(|r| {
                    let mut o = Map::new();
                    for k in ["site", "codefou", "nom_fou", "franco_ht", "franco_atteint"] {
                        if let Some(v) = r.get(k) {
                            o.insert(k.to_string(), v.clone());
                        }
                    }
                    Value::Object(o)
                }).collect::<Vec<_>>(),
            })
        }
        Err(e) => json!({ "error": string_erreur(&message_erreur(&e)) }),
    };

    // Probe des fournisseurs N/A pour trouver où est leur franco
    let (detail_m036_292, detail_m030_579, fournisseur_m036, fournisseur_m030) = tokio::join!(
        probe(format!("{ff_api_base}/api/commandes-auto/M036?site=292")),
        probe(format!("{ff_api_base}/api/commandes-auto/M030?site=579")),
        probe(format!("{ff_api_base}/api/fournisseurs/M036")),
        probe(format!("{ff_api_base}/api/fournisseurs/M030")),
    );
    let franco_na_probe = json!({
        "detailM036_292": detail_m036_292,
        "detailM030_579": detail_m030_579,
        "fournisseurM036": fournisseur_m036,
        "fournisseurM030": fournisseur_m030,
    });

    // Raw commandes-auto (premier fournisseur) pour voir les champs réels retournés par l'API
    let raw_commandes_auto = probe(format!("{ff_api_base}/api/commandes-auto")).await;

    Json(json!({
        "timestamp": crate::db::iso_utc(chrono::Utc::now()),
        "dateRange": { "dateDebut": date_debut, "dateFin": date_fin },
        "codefouTested": codefou,
        "firstCodeinTested": first_codein,
        "forcedNoid": forced_noid.unwrap_or_else(|| "(none — pass ?noid=129632 to test a specific article)".into()),
        "fournisseurs": fournisseurs,
        "articles": articles,
        "mouvements_dateDebut": mvt_date_debut,
        "endpoints_auto": {
            "articles/:no_id/mensuel": mensuel_noid,
            "articles/:no_id/referentiel": referentiel,
        },
        "endpoints_forced_noid": {
            "articles/:noid/mensuel": mensuel_forced,
            "articles/:noid/referentiel": referentiel_forced,
        },
        "postgresql": postgresql,
        "ventesProduitsDiag": ventes_produits_diag,
        "mvtartDiag": mvtart_diag,
        "francoDiag": franco_diag,
        "rawCommandesAuto": raw_commandes_auto,
        "commandesAutoFrancoAudit": commandes_auto_franco_audit,
        "francoNaProbe": franco_na_probe,
    }))
    .into_response()
}
