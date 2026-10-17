//! Test d'intégration du module FF sur une base de test.
//!
//! Ne s'exécute que si `FF_TEST_DATABASE_URL` désigne une base contenant les
//! tables de l'application et des tables FF minimales (articles, artfou1,
//! mvtart, cube_stock…). Une fausse API FF Nancy est servie localement : toutes
//! les requêtes SQL et tous les appels HTTP du module sont joués au moins une
//! fois (erreurs de syntaxe SQL, de décodage de types, formes JSON).
//!
//!     FF_TEST_DATABASE_URL=postgres://…/ff_fixture cargo test ff::fixture_tests -- --nocapture

use super::*;
use crate::auth::Claims;
use crate::rpc::Ctx;
use axum::body::Body;
use axum::extract::{Path, Query};
use axum::http::Request;
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use tower::ServiceExt;

/// Fausse API FF Nancy (formes de réponse reprises du code d'origine).
async fn fausse_api() -> String {
    async fn dashboard(Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        let date = q.get("date").cloned().unwrap_or_default();
        Json(json!({
            "date": date,
            "sites": [
                { "site": "292", "ca_ttc": "1500.50", "ca_ttc_n1": 1200, "trafic": 80, "trafic_n1": "70" },
                { "site": "579", "ca_ttc": 900, "ca_ttc_n1": 0, "trafic": 40, "trafic_n1": 35 }
            ],
            "top10_ca": [
                { "codein": "100001", "libelle1": "TAPIS", "site": "292", "ca_ttc": "45.5", "qte_vendue": 3, "marge": 12 },
                { "codein": "100002", "libelle1": "CREME", "site": "292", "ca_ttc": 60, "qte_vendue": 1, "marge": 2 },
                { "codein": "100003", "libelle1": "BOUGIE", "site": "579", "ca_ttc": 10, "qte_vendue": 1, "marge": 1 }
            ],
            "top10_qte": [{ "codein": "100001", "libelle1": "TAPIS", "site": "292", "ca_ttc": 45.5, "qte_vendue": 3, "marge": 12 }],
            "top10_marge": []
        }))
    }
    async fn articles(Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        if let Some(c) = q.get("codein") {
            if c == "100003" {
                return Json(json!({ "articles": [] }));
            }
            return Json(json!({ "articles": [{ "no_id": if c == "100001" { 10 } else { 11 }, "codein": c }] }));
        }
        let page: u32 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
        if page > 1 {
            return Json(json!({ "articles": [] }));
        }
        Json(json!({ "count": 2, "articles": [
            { "codein": "100001", "libelle1": "TAPIS", "codefou_principal": "F001", "pcb_principal": "6", "no_id": 10, "actif": "1", "suspendu": 0 },
            { "Codein": "100002", "libelle": "CREME", "pv": 3.5, "noid": "11", "gtin": "300" }
        ]}))
    }
    async fn referentiel(Path(id): Path<String>) -> Json<Value> {
        Json(json!({
            "article": { "no_id": id, "codein": "x" },
            "stock": [{ "site": "292", "qte": "4" }, { "site": "579", "qte": 2 }],
            "fournisseurs": [{ "codefou": "F001", "nom_fou": " Fournisseur Un ", "preference": 0 }, { "codefou": "F002", "nom_fou": null, "preference": 1 }]
        }))
    }
    async fn dernier(Path(id): Path<String>) -> Json<Value> {
        if id == "10" {
            Json(json!({ "fournisseurs_par_site": [{ "site": "292", "nom_fournisseur": "" }, { "site": "579", "nom_fournisseur": " Dernier Fou " }] }))
        } else {
            Json(json!({ "fournisseurs_par_site": [] }))
        }
    }
    async fn mensuel(Path(id): Path<String>) -> Json<Value> {
        Json(json!({ "data": [{ "mois": "2026-01", "site": 292, "stock_fin_mois": "5.000", "prmp_fin_mois": "1",
            "ventes": { "nb_passages": "2", "qte_vendue": "-2.000", "ca_ht": "-26.66", "ca_ttc": "-30", "marge": "12.76", "taux_marge": "40" },
            "receptions": null, "id": id }] }))
    }
    async fn commandes_auto(Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        Json(json!({ "count": 3, "query": q, "propositions": [
            { "site": "292", "codefou": "F001", "nom_fou": "Fournisseur Un", "franco_ht": "150", "nb_articles": 4, "montant_propo_ht": 99.5, "franco_atteint": "NON", "ecart_franco": -50.5 },
            { "site": "579", "codefou": "F002", "nom_fou": "Fournisseur Deux", "franco_ht": null, "nb_articles": 1, "montant_propo_ht": 10, "franco_atteint": "N/A", "ecart_franco": 0 },
            { "site": "292", "codefou": "F009", "nomfou": "Sans franco", "franco": 0, "nb_articles": 1, "montant_cde": 5, "franco_atteint": 1 }
        ]}))
    }
    async fn commandes_auto_detail(Path(codefou): Path<String>, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        match (codefou.as_str(), q.get("site").map(|s| s.as_str())) {
            ("F002", None) => Json(json!({ "resume": [{ "franco_ht": "300" }] })),
            ("F009", Some("000")) => Json(json!({ "summary": { "franco": 75 } })),
            _ => Json(json!({ "error": "inconnu" })),
        }
    }
    async fn commandes_articles() -> Json<Value> {
        Json(json!([{ "codein": "100001", "qtecde": 5 }, { "codein": "100001", "qtecde": 3 }, { "codein": "100002" }]))
    }
    async fn sync_status() -> Json<Value> {
        Json(json!({ "sync": [{ "table_name": "mvtart", "last_sync": "2026-10-12T02:00:00Z", "rows_synced": 42, "status": "ok", "error_msg": null }] }))
    }
    async fn publicites(Query(q): Query<HashMap<String, String>>) -> Json<Value> {
        Json(json!({ "publicites": [{ "tcr_code": "P1", "intitule": "Promo", "query": q }], "total": "1", "pages": 1 }))
    }
    async fn historique() -> axum::http::StatusCode {
        axum::http::StatusCode::BAD_GATEWAY
    }

    use axum::routing::get;
    let app = axum::Router::new()
        .route("/api/performance/dashboard", get(dashboard))
        .route("/api/articles", get(articles))
        .route("/api/articles/{id}/referentiel", get(referentiel))
        .route("/api/articles/{id}/dernier-fournisseur", get(dernier))
        .route("/api/articles/{id}/mensuel", get(mensuel))
        .route("/api/commandes-auto", get(commandes_auto))
        .route("/api/commandes-auto/{codefou}", get(commandes_auto_detail))
        .route("/api/commandes/articles", get(commandes_articles))
        .route("/api/sync/status", get(sync_status))
        .route("/api/fournisseurs", get(|| async { Json(json!({ "fournisseurs": [{ "codefou": "F001" }] })) }))
        .route("/api/publicites", get(publicites))
        .route("/api/publicites/historique", get(historique));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn montrer(nom: &str, v: impl serde::Serialize) -> Value {
    let v = serde_json::to_value(v).unwrap();
    println!("── {nom}\n{}", serde_json::to_string_pretty(&v).unwrap());
    v
}

async fn appel_route(token: &str, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .uri(uri)
        .header("cookie", format!("{}={token}", crate::auth::session::COOKIE_NAME))
        .body(Body::empty())
        .unwrap();
    let res = router().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn ctx(claims: &Claims, query: &[(&str, &str)], args: Vec<Value>) -> Ctx {
    Ctx {
        token: Some(claims.clone()),
        query: query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        args,
    }
}

#[tokio::test]
async fn module_ff_sur_base_de_test() {
    let Ok(url) = std::env::var("FF_TEST_DATABASE_URL") else {
        eprintln!("FF_TEST_DATABASE_URL absent : test d'intégration FF ignoré.");
        return;
    };
    let data_dir = std::env::temp_dir().join(format!("cf-ff-test-{}", std::process::id()));
    std::fs::create_dir_all(&data_dir).unwrap();
    std::env::set_var("DATA_DIR", &data_dir);
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("AUTH_SECRET", "secret-de-test");
    let base = fausse_api().await;
    std::env::set_var("FF_API_BASE_URL", &base);
    api::reset_ff_api_base_cache();

    let p = crate::db::pool().unwrap();
    sqlx::query("INSERT INTO users (id, username, password_hash, role) VALUES (9001, 'test-ff', 'x', 'admin') ON CONFLICT DO NOTHING")
        .execute(&p)
        .await
        .unwrap();
    let claims = Claims { id: "9001".into(), name: "test-ff".into(), role: "admin".into(), exp: chrono::Utc::now().timestamp() + 3600 };
    let token = crate::auth::session::encode(&claims);
    let r12 = api::build_last12_months_range();
    let (d, f) = (r12.date_debut.as_str(), r12.date_fin.as_str());
    let codes = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    // ── pg.rs
    let fous = montrer("pg_get_fournisseurs", pg::pg_get_fournisseurs(None).await);
    assert_eq!(fous.as_array().unwrap().len(), 2, "F003 (nom vide) écarté");
    montrer("pg_get_fournisseurs(search)", pg::pg_get_fournisseurs(Some("deux")).await);
    let arts = pg::pg_get_articles_by_fournisseur("F001").await.unwrap();
    montrer("pg_get_articles_by_fournisseur", &arts);
    assert!(arts.iter().all(|a| a.codein.trim() != "100004"), "article suspendu exclu");
    assert!(arts.iter().any(|a| a.code_centrale.as_deref() == Some("10000111111") && a.pa == Some(4.5)));
    montrer("pg_get_mensuel_by_fournisseur", pg::pg_get_mensuel_by_fournisseur("F001", d, f).await.unwrap());
    montrer("pg_get_gammes_by_fournisseur", pg::pg_get_gammes_by_fournisseur("F001").await.unwrap());
    let g = pg::pg_get_gammes_by_codeins(&codes(&["100001", " 100002 ", "", "100001"])).await.unwrap();
    montrer("pg_get_gammes_by_codeins", &g);
    assert_eq!(g.get("100001").map(|s| s.as_str()), Some("C"));
    montrer("pg_get_nomenclature_by_fournisseur", pg::pg_get_nomenclature_by_fournisseur("F001").await.unwrap());
    montrer("pg_get_stock_by_fournisseur", pg::pg_get_stock_by_fournisseur("F001").await.unwrap());
    let pv = pg::pg_get_prix_vente_by_fournisseur("F001").await.unwrap();
    montrer("pg_get_prix_vente_by_fournisseur", &pv);
    assert_eq!(pv.values().next().and_then(|m| m.get("292")).copied(), Some(12.5), "site élagué");
    montrer("pg_get_commandes_by_fournisseur", pg::pg_get_commandes_by_fournisseur("F001").await.unwrap());
    let mois = chrono::Local::now().date_naive().format("%Y-%m").to_string();
    let n1 = pages::get_mois_n1(&mois);
    montrer("pg_get_ca_by_fournisseur", pg::pg_get_ca_by_fournisseur(&mois, &n1).await.unwrap());
    montrer("pg_get_ca_by_nomenclature", pg::pg_get_ca_by_nomenclature(&r12.date_fin[..7], &mois).await.unwrap());
    let hp = pg::pg_get_hit_parade(d, &chrono::Local::now().date_naive().to_string()).await.unwrap();
    montrer("pg_get_hit_parade", &hp);
    assert!(!hp.is_empty());
    montrer("pg_get_stock_for_codeins", pg::pg_get_stock_for_codeins(&codes(&["100001", "100003"])).await.unwrap());
    montrer("pg_diag_fournisseur_derniere_entree", pg::pg_diag_fournisseur_derniere_entree().await.unwrap());
    montrer("pg_get_stock_sans_vente", pg::pg_get_stock_sans_vente(None).await.unwrap());
    montrer("pg_get_stock_sans_vente(292)", pg::pg_get_stock_sans_vente(Some("292")).await.unwrap());
    let neg = pg::pg_get_stock_negatif(None).await.unwrap();
    montrer("pg_get_stock_negatif", &neg);
    assert!(!neg.is_empty());
    montrer("pg_get_stock_negatif(579)", pg::pg_get_stock_negatif(Some("579")).await.unwrap());
    montrer("pg_get_sans_vente_6_mois", pg::pg_get_sans_vente_6_mois(None).await.unwrap());
    montrer("pg_get_sans_vente_6_mois(579)", pg::pg_get_sans_vente_6_mois(Some("579")).await.unwrap());
    let rec = pg::pg_get_derniere_reception_par_fournisseur(None).await;
    montrer("pg_get_derniere_reception_par_fournisseur(None)", &rec);
    assert!(!rec.is_empty());
    montrer("pg_get_derniere_reception_par_fournisseur(F001)", pg::pg_get_derniere_reception_par_fournisseur(Some(&codes(&["F001 "]))).await);
    assert!(pg::pg_get_derniere_reception_par_fournisseur(Some(&[])).await.is_empty());
    let search = pg::pg_search_produits("tapis poussiere", 50).await;
    montrer("pg_search_produits", &search);
    assert_eq!(search.len(), 1);
    assert!(search[0].has_reseau);
    montrer("pg_search_produits(numérique)", pg::pg_search_produits("100003", 50).await);
    montrer("pg_search_produits(code centrale)", pg::pg_search_produits("10000222", 50).await);
    montrer("pg_search_produits(!!!)", pg::pg_search_produits("!!!", 50).await);
    montrer("pg_get_produits_by_code_centrale", pg::pg_get_produits_by_code_centrale(&codes(&["10000222222", "inconnu"])).await);
    assert_eq!(pg::pg_get_codein_by_code_centrale("10000222222").await.as_deref(), Some("100002"));
    let det = pg::pg_get_produit_detail("100001").await;
    montrer("pg_get_produit_detail", &det);
    assert_eq!(det.as_ref().and_then(|d| d.code1.clone()).as_deref(), Some("33"), "hiérarchie remontée");
    montrer("pg_get_fournisseurs_by_codein", pg::pg_get_fournisseurs_by_codein("100003").await);
    montrer("pg_get_stock_by_codein", pg::pg_get_stock_by_codein("100001").await);
    assert_eq!(pg::pg_get_commandes_by_codein("100001").await, 30.0);
    montrer("pg_get_gamme_history_by_codein", pg::pg_get_gamme_history_by_codein("100001").await);
    montrer("pg_get_mensuel_by_codein", pg::pg_get_mensuel_by_codein("100001", d, f).await);
    let opp = pg::pg_get_opportunites_famille(3, d, f, 30).await;
    montrer("pg_get_opportunites_famille", &opp);
    assert_eq!(opp.len(), 2);

    // ── API FF (fausse)
    let dash = pg::pg_get_dashboard_data().await.unwrap();
    let dv = montrer("pg_get_dashboard_data", &dash);
    assert_eq!(dv["top10BySite"][0]["ca"][1]["fournisseur"], json!("Dernier Fou"));
    assert_eq!(dv["top10BySite"][0]["ca"][0]["fournisseur"], json!("F002"));
    let ca = montrer("pg_get_commandes_auto", pg::pg_get_commandes_auto().await);
    assert_eq!(ca[1]["franco"], json!(300.0));
    assert_eq!(ca[2]["franco"], json!(75.0));
    let ffarts = api::get_articles_by_fournisseur("F001").await.unwrap();
    montrer("get_articles_by_fournisseur", &ffarts);
    montrer("get_mensuel_by_articles", api::get_mensuel_by_articles(&ffarts, d, f, 50).await);
    montrer("get_referentiel_by_articles", api::get_referentiel_by_articles(&ffarts, 50).await);
    montrer("get_commandes_by_fournisseur", api::get_commandes_by_fournisseur("F001").await);
    montrer("diagnostiquer_api_ff", diagnostic::diagnostiquer_api_ff(None, None).await);
    montrer("diagnostiquer_api_ff(injoignable)", diagnostic::diagnostiquer_api_ff(Some("http://127.0.0.1:9".into()), None).await);

    // ── cache.rs
    montrer("get_derniere_reception_cached", cache::get_derniere_reception_cached(&codes(&["F002", "F001"])).await.unwrap());

    // ── Routes
    for uri in ["/api/ff-status", "/api/diag/stock-fournisseur", "/api/test-db?codein=100001", "/api/commandes-auto?site=292", "/api/diag"] {
        let (status, body) = appel_route(&token, uri).await;
        montrer(&format!("GET {uri} → {status}"), &body);
        assert_eq!(status, 200, "{uri}");
    }

    // ── Actions
    let c = |args: Vec<Value>| ctx(&claims, &[], args);
    montrer("getFournisseurs", actions::get_fournisseurs(c(vec![])).await.unwrap());
    montrer("getMagasins", actions::get_magasins(c(vec![])).await.unwrap());
    montrer("getFournisseursPourCadence", actions::get_fournisseurs_pour_cadence(c(vec![])).await.unwrap());
    montrer("upsertCadence", actions::upsert_cadence(c(vec![json!({ "codefou": " F002 ", "site": "292", "intervalleSemaines": "2.5" })])).await.unwrap());
    montrer("upsertCadence(KO)", actions::upsert_cadence(c(vec![json!({ "codefou": "F002", "site": "292", "intervalleSemaines": 0 })])).await.unwrap());
    montrer("toggleCadence", actions::toggle_cadence(c(vec![json!("F002"), json!("292"), json!(false)])).await.unwrap());
    let cad = montrer("listCadences", actions::list_cadences(c(vec![])).await.unwrap());
    assert!(cad.as_array().unwrap().iter().any(|x| x["derniereReception"].is_string() && x["joursRestants"].is_number()));
    montrer("removeCadence", actions::remove_cadence(c(vec![json!("F002"), json!("292")])).await.unwrap());
    let sans = Ctx::default();
    assert_eq!(actions::get_fournisseurs(sans.clone()).await.unwrap_err().status.as_u16(), 401);
    assert_eq!(actions::remove_cadence(sans.clone()).await.unwrap(), json!({ "ok": false, "error": "Session expirée : reconnectez-vous." }));

    // ── Pages
    montrer("page dashboard", pages::page_dashboard(ctx(&claims, &[], vec![])).await.unwrap());
    montrer("page analytics", pages::page_analytics(ctx(&claims, &[("mode", "fournisseur")], vec![])).await.unwrap());
    montrer("page analytics (nomenclature)", pages::page_analytics(ctx(&claims, &[("mode", "x"), ("mois", &mois)], vec![])).await.unwrap());
    montrer("page hit-parade", pages::page_hit_parade(ctx(&claims, &[], vec![])).await.unwrap());
    montrer("page stock-negatif", pages::page_stock_negatif(ctx(&claims, &[("magasin", "292")], vec![])).await.unwrap());
    montrer("page commandes-auto", pages::page_commandes_auto(ctx(&claims, &[], vec![])).await.unwrap());
    let pubs = montrer("page publicites", pages::page_publicites(ctx(&claims, &[("statut", "en_cours"), ("page", "2")], vec![])).await.unwrap());
    assert_eq!(pubs["pageSize"], json!(50));
    assert!(pubs["erreurHistorique"].is_string());
    assert!(pubs.get("erreurPublicites").is_none());
    assert_eq!(pages::page_dashboard(sans).await.unwrap_err().status.as_u16(), 401);

    sqlx::query("DELETE FROM users WHERE id = 9001").execute(&p).await.unwrap();
}
