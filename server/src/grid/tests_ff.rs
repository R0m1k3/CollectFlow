//! Test d'intégration du calcul de la grille (phase 2) sur une base de test
//! contenant les tables FF (`ff_fixture`), avec une fausse API FF Nancy.
//!
//! ```sh
//! GRID_FF_TEST_DATABASE_URL=postgres://postgres:postgres@localhost/ff_fixture cargo test grid::tests_ff -- --nocapture
//! ```
//!
//! Écrit dans `grid_rows`, `session_snapshots`, `gammes_a_valider`, `users` et
//! `api_keys` de la base de test (nettoyés à la fin).

use super::enrich::enrich_rows;
use super::months;
use super::product_rows::*;
use super::rows_cache;
use super::store::*;
use crate::auth::Claims;
use axum::body::Body;
use axum::extract::Path;
use axum::http::Request;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower::ServiceExt;

const CLE_API: &str = "cf_cle-de-test-grille-phase-2";

/// Fausse API FF : seul l'historique mensuel sert au complément par magasin.
async fn fausse_api(mois: String) -> String {
    let app = Router::new().route(
        "/api/articles/{id}/mensuel",
        get(move |Path(id): Path<String>| {
            let mois = mois.clone();
            async move {
                Json(json!({ "data": [
                    { "mois": mois, "site": "579", "stock_fin_mois": "7.000",
                      "ventes": { "qte_vendue": "-3.000", "ca_ht": "-30.00", "marge": "9.5" },
                      "receptions": { "qte_recue": "2" }, "id": id },
                    { "mois": mois, "site": "292", "stock_fin_mois": "1",
                      "ventes": { "qte_vendue": "-100", "ca_ht": "-1", "marge": "0" } }
                ] }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

async fn appel(req: Request<Body>) -> (u16, Vec<u8>) {
    let res = super::router().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    (status, axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec())
}

fn get_cle(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).header("x-api-key", CLE_API).body(Body::empty()).unwrap()
}

fn json_de(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap_or_else(|e| panic!("JSON illisible ({e}) : {}", String::from_utf8_lossy(b)))
}

async fn nettoyer(pool: &sqlx::PgPool) {
    for sql in [
        "delete from grid_rows where code_fournisseur in ('F001', 'F002', 'F404')",
        "delete from session_snapshots where code_fournisseur in ('F001', 'F002')",
        "delete from gammes_a_valider where code_fournisseur in ('F001', 'F002')",
        "delete from api_keys where name = 'test-grille'",
        "delete from users where username = 'test-grille'",
    ] {
        sqlx::query(sql).execute(pool).await.unwrap();
    }
}

#[tokio::test]
async fn calcul_de_la_grille_et_routes() {
    let Ok(url) = std::env::var("GRID_FF_TEST_DATABASE_URL") else {
        eprintln!("GRID_FF_TEST_DATABASE_URL absent : test d'intégration du calcul ignoré.");
        return;
    };
    let _verrou = rows_cache::TEST_LOCK.lock();
    let dir = std::env::temp_dir().join(format!("grid-ff-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("DATA_DIR", &dir);
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("AUTH_SECRET", "secret-de-test");
    crate::db::refresh();
    let periods = months::get_last12_months(months::today());
    let dernier_mois = months::ff_month_to_qlik(periods.last().unwrap());
    std::env::set_var("FF_API_BASE_URL", fausse_api(dernier_mois).await);
    crate::ff::api::reset_ff_api_base_cache();

    let pool = crate::db::pool().unwrap();
    sqlx::raw_sql(include_str!("../../sql/init.sql")).execute(&pool).await.unwrap();
    nettoyer(&pool).await;
    rows_cache::invalidate_grid_rows_cache(None);

    // ── calcul complet ─────────────────────────────────────────────────────
    let rows = get_product_rows(GetProductRowsInput::total("F001", false)).await.unwrap();
    let lignes = rows.snapshot();
    println!("── lignes calculées\n{}", serde_json::to_string_pretty(&lignes).unwrap());
    assert!(!lignes.is_empty());
    // `articles.codein` est un char(10) dans la base de test : codes complétés d'espaces.
    let tapis = lignes.iter().find(|r| r.codein.trim() == "100001").expect("article 100001");
    let code_tapis = tapis.codein.clone();
    let tapis_url = urlencoding::encode(&code_tapis).into_owned();
    assert_eq!(tapis.sales12m.len(), 12);
    assert_eq!(tapis.code_centrale.as_deref(), Some("10000111111"));
    assert_eq!(tapis.ca_reseau, Some(50000.0), "métriques réseau du cache Qlik");
    assert_eq!(tapis.taux_presence_reseau, Some(1.0));
    assert!(tapis.sales12m_by_store.as_ref().unwrap().contains_key("292"));
    assert!(tapis.working_stores.contains(&"292".to_string()));
    assert_eq!(tapis.stock_actuel, Some(4.0), "5 + -1 sur les deux sites");
    assert_eq!(tapis.prix_vente, Some(12.9), "le PV le plus élevé des deux magasins");
    assert!(tapis.total_quantite > 0.0 && tapis.total_ca > 0.0);

    // Persistance (lancée en arrière-plan) puis instantané.
    attendre_persistance("F001").await;
    let fraicheur = get_grid_freshness("F001").await.unwrap().expect("instantané écrit");
    assert_eq!(fraicheur.row_count as usize, lignes.len());

    // Cache : même tableau partagé.
    let encore = get_product_rows(GetProductRowsInput::total("F001", false)).await.unwrap();
    assert!(std::sync::Arc::ptr_eq(&rows, &encore));

    // Instantané resservi après invalidation du cache, gammes du snapshot reportées.
    sqlx::query("insert into session_snapshots (code_fournisseur, magasin, changes, type) values ('F001', 'TOTAL', $1, 'snapshot')")
        .bind(json!({ code_tapis.clone(): { "before": null, "after": "Z" } }))
        .execute(&pool)
        .await
        .unwrap();
    rows_cache::invalidate_grid_rows_cache(Some("F001"));
    let servies = get_product_rows(GetProductRowsInput::total("F001", false)).await.unwrap();
    assert!(!std::sync::Arc::ptr_eq(&rows, &servies));
    assert_eq!(servies.len(), lignes.len());
    let s = servies.snapshot();
    assert_eq!(s.iter().find(|r| r.codein == code_tapis).unwrap().code_gamme.as_deref(), Some("Z"));
    assert!(s.iter().all(|r| r.payload_version == Some(GRID_PAYLOAD_VERSION)), "lignes issues de grid_rows");

    // Synchro : recalcul forcé, nombre de lignes.
    assert_eq!(get_product_rows_for_sync("F001").await.unwrap(), lignes.len());

    // ── complément par magasin (fausse API FF) ─────────────────────────────
    let patch = get_store_patch("F001", "579").await.unwrap();
    println!("── complément 579\n{}", serde_json::to_string_pretty(&*patch).unwrap());
    assert_eq!(patch.magasin, "579");
    assert_eq!(patch.periods, periods);
    assert!(!patch.entries.is_empty());
    assert!(patch.entries.iter().all(|e| e.quantite == 3.0 && e.ca == 30.0));
    let meme = get_store_patch("F001", "579").await.unwrap();
    assert!(std::sync::Arc::ptr_eq(&patch, &meme), "complément partagé");

    // Vue d'un magasin : rattrapage appliqué aux lignes.
    let vue_579 =
        get_product_rows(GetProductRowsInput { code_fournisseur: "F001".into(), magasin: Some("579".into()), force_refresh: false })
            .await
            .unwrap();
    assert!(vue_579.snapshot().iter().any(|r| r.quantite_by_store.as_ref().and_then(|q| q.get("579")).copied() == Some(3.0)));

    // ── enrichissement /api/v1 ─────────────────────────────────────────────
    let enrichies =
        enrich_rows(query_grid_rows(&GridQuery { code_fournisseur: Some("F001".into()), ..Default::default() }).await.unwrap().rows).await;
    let e = enrichies.iter().find(|r| r.row.codein == code_tapis).unwrap();
    assert_eq!(e.network.as_ref().map(|n| n.ca_reseau), Some(50000.0));
    let v = serde_json::to_value(e).unwrap();
    assert!(v.get("codeGammeServeur").is_some() && v.get("gammeAValider").is_some() && v.get("trend").is_some());
    assert_eq!(v["codein"], json!(code_tapis));

    // ── routes ─────────────────────────────────────────────────────────────
    let (id_user,): (i32,) =
        sqlx::query_as("insert into users (username, password_hash, role) values ('test-grille', 'x', 'admin') returning id")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("insert into api_keys (name, key_prefix, key_hash, role) values ('test-grille', 'cf_cle', $1, 'user')")
        .bind(crate::auth::api_key::hash_api_key(CLE_API))
        .execute(&pool)
        .await
        .unwrap();
    let claims =
        Claims { id: id_user.to_string(), name: "test-grille".into(), role: "admin".into(), exp: chrono::Utc::now().timestamp() + 3600 };
    let cookie = format!("{}={}", crate::auth::session::COOKIE_NAME, crate::auth::session::encode(&claims));
    let get_session = |uri: &str| Request::builder().uri(uri).header("cookie", cookie.clone()).body(Body::empty()).unwrap();

    // /api/grid/rows (NDJSON)
    let (st, corps) = appel(get_session("/api/grid/rows?fournisseur=F001&magasin=TOTAL&chunkSize=1")).await;
    assert_eq!(st, 200);
    let messages: Vec<Value> = String::from_utf8(corps).unwrap().lines().map(|l| json_de(l.as_bytes())).collect();
    assert_eq!(messages[0], json!({ "type": "start", "loaded": 0, "total": null }));
    let chunks: Vec<&Value> = messages.iter().filter(|m| m["type"] == "chunk").collect();
    // chunkSize=1 est relevé au minimum de 50 : un seul lot ici.
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0]["rows"].as_array().unwrap().len(), lignes.len());
    assert_eq!(chunks[0]["loaded"], lignes.len());
    assert_eq!(messages.last().unwrap(), &json!({ "type": "done", "loaded": lignes.len(), "total": lignes.len() }));
    let (st, _) = appel(get_session("/api/grid/rows")).await;
    assert_eq!(st, 400);
    let (st, _) = appel(Request::builder().uri("/api/grid/rows?fournisseur=F001").body(Body::empty()).unwrap()).await;
    assert_eq!(st, 401);

    // /api/grid/rows/store-patch
    let (st, corps) = appel(get_session("/api/grid/rows/store-patch?fournisseur=F001&magasin=579")).await;
    assert_eq!(st, 200);
    assert_eq!(json_de(&corps)["magasin"], "579");
    let (st, corps) = appel(get_session("/api/grid/rows/store-patch?fournisseur=F001&magasin=TOTAL")).await;
    assert_eq!((st, json_de(&corps)), (400, json!({ "error": "Paramètres fournisseur et magasin requis." })));

    // /api/v1/grid : diffusion complète, puis page
    let (st, corps) = appel(get_cle("/api/v1/grid?fournisseur=F001")).await;
    assert_eq!(st, 200);
    let tout = json_de(&corps);
    assert_eq!(tout["data"].as_array().unwrap().len(), lignes.len());
    assert_eq!(tout["meta"]["diffuse"], true);
    assert_eq!(tout["meta"]["complet"], true);
    assert_eq!(tout["pagination"]["total"], lignes.len());
    let (st, corps) = appel(get_cle("/api/v1/grid?fournisseur=F001&limit=1&fields=totalCa&sort=codein&order=asc")).await;
    assert_eq!(st, 200);
    let page = json_de(&corps);
    assert_eq!(page["data"][0].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["totalCa", "codein"]);
    assert_eq!(page["meta"]["complet"], json!(lignes.len() <= 1));
    if lignes.len() > 1 {
        assert!(page["meta"]["avertissement"].as_str().unwrap().contains("page=2"));
    }
    let (st, corps) = appel(get_cle("/api/v1/grid?fournisseur=F002&compute=0")).await;
    assert_eq!((st, json_de(&corps)["error"]["code"].clone()), (202, json!("not_ready")));
    let (st, corps) = appel(get_cle("/api/v1/grid?fournisseur=F002")).await;
    let f002 = json_de(&corps);
    assert_eq!(st, 200, "{f002}");
    assert_eq!(f002["meta"]["computedOnDemand"], true);
    let (st, corps) = appel(get_cle("/api/v1/grid?fournisseur=F404")).await;
    assert_eq!((st, json_de(&corps)["error"]["code"].clone()), (404, json!("not_found")));

    // /api/v1/products/*
    let (st, corps) = appel(get_cle("/api/v1/products/search?q=tapis&fields=libelle1")).await;
    assert_eq!(st, 200);
    let rech = json_de(&corps);
    assert_eq!(rech["data"][0]["codein"], json!(code_tapis));
    assert_eq!(rech["meta"]["scope"], "tous fournisseurs");
    let (st, corps) = appel(get_cle(&format!("/api/v1/products/{tapis_url}?fournisseur=F001"))).await;
    assert_eq!(st, 200);
    let fiche = json_de(&corps);
    assert_eq!(fiche["meta"]["hasNetwork"], true);
    assert_eq!(fiche["data"]["network"]["caReseau"], 50000);
    let (st, _) = appel(get_cle("/api/v1/products/999999")).await;
    assert_eq!(st, 404);

    // Gammes : proposition à valider, puis lot avec un inconnu (tout ou rien).
    let put = Request::builder()
        .method("PUT")
        .uri(format!("/api/v1/products/{tapis_url}/gamme"))
        .header("x-api-key", CLE_API)
        .header("content-type", "application/json")
        .body(Body::from(r#"{"gamme":"A","fournisseur":"F001"}"#))
        .unwrap();
    let (st, corps) = appel(put).await;
    let rep = json_de(&corps);
    assert_eq!(st, 200, "{rep}");
    assert_eq!(rep["data"]["statut"], "a_valider");
    assert_eq!(rep["data"]["codeFournisseur"], "F001");
    let a_valider = super::gammes_a_valider::lister_gammes_a_valider("F001").await.unwrap();
    assert_eq!((a_valider[0].codein.as_str(), a_valider[0].auteur.as_deref()), (code_tapis.as_str(), Some("test-grille")));
    let post = |corps: &str| {
        Request::builder().method("POST").uri("/api/v1/gammes").header("x-api-key", CLE_API).body(Body::from(corps.to_string())).unwrap()
    };
    let (st, corps) = appel(post(
        &json!({ "fournisseur": "F001", "changes": [{ "codein": code_tapis, "gamme": "B" }, { "codein": "XXX", "gamme": "A" }] })
            .to_string(),
    ))
    .await;
    let rep = json_de(&corps);
    assert_eq!(st, 404);
    assert_eq!(rep["error"]["details"]["inconnus"], json!(["XXX"]));
    let (st, corps) = appel(post("pas du json")).await;
    assert_eq!(
        (st, json_de(&corps)["error"]["message"].clone()),
        (400, json!("Corps de requête JSON attendu (Content-Type: application/json)."))
    );
    let (st, corps) = appel(post(&json!({ "fournisseur": "F001", "changes": [{ "codein": code_tapis, "gamme": "Z" }] }).to_string())).await;
    let rep = json_de(&corps);
    assert_eq!(st, 200, "{rep}");
    assert_eq!(rep["meta"]["demandes"], 1);

    // /api/v1/fournisseurs, /api/v1/network
    let (st, corps) = appel(get_cle("/api/v1/fournisseurs")).await;
    assert_eq!(st, 200);
    let fous = json_de(&corps);
    assert!(fous["data"].as_array().unwrap().iter().any(|f| f["code"] == "F001" && f["hasSnapshot"] == true));
    let (st, corps) = appel(get_cle("/api/v1/fournisseurs?withData=1&search=f00")).await;
    assert_eq!(st, 200);
    assert_eq!(json_de(&corps)["meta"]["scope"], "instantané uniquement");
    let (st, corps) = appel(get_cle("/api/v1/network/10000111111")).await;
    assert_eq!(st, 200);
    let net = json_de(&corps);
    assert_eq!(net["data"].as_object().unwrap().keys().next().unwrap(), "codeCentrale");
    assert_eq!(net["meta"]["source"], "cache");
    let (st, _) = appel(get_cle("/api/v1/network/inconnu")).await;
    assert_eq!(st, 404);

    nettoyer(&pool).await;
    rows_cache::invalidate_grid_rows_cache(None);
}
