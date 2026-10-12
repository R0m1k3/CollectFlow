//! Tests de la plomberie Chromium/CDP (sans serveur Qlik).
//!
//! Le test principal est ignoré par défaut (il lance un vrai Chromium) :
//! `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//!  cargo test -- --ignored plomberie_cdp`

use super::browser::{dans_la_file_qlik, get_qlik_browser, PageQlik};
use axum::http::HeaderMap;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

const PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>faux Qlik</title></head><body>
<p id="cookie">COOKIE</p>
<script>
  console.log("[cf] bonjour depuis la page", 42);
  console.log("bruit du client Qlik");
  // Le vrai client Qlik ouvre son websocket Engine avec le jeton CSRF dans l'URL.
  try { new WebSocket("ws://" + location.host + "/app/abc?qlik-csrf-token=jeton%2Fsecret&x=1"); } catch (e) {}
  setTimeout(() => { throw new Error("erreur volontaire"); }, 10);
</script></body></html>"#;

/// Défi HTTP Basic : la page doit répondre avec les identifiants (`httpCredentials`).
async fn protege(headers: HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some(a) => format!("autorisé {a}").into_response(),
        None => (axum::http::StatusCode::UNAUTHORIZED, [("www-authenticate", "Basic realm=\"qlik\"")], "refusé").into_response(),
    }
}

async fn racine(headers: HeaderMap) -> Html<String> {
    let cookie = headers.get("cookie").and_then(|v| v.to_str().ok()).unwrap_or("(aucun)").to_string();
    Html(PAGE.replace("COOKIE", &cookie))
}

#[tokio::test]
#[ignore]
async fn plomberie_cdp() {
    if std::env::var("PLAYWRIGHT_CHROMIUM_PATH").is_err() {
        std::env::set_var("PLAYWRIGHT_CHROMIUM_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
    }
    // Petit serveur HTTP local.
    let app = Router::new().route("/", get(racine)).route("/app/abc", get(|| async { "pas un websocket" })).route("/protege", get(protege));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let browser = get_qlik_browser().await.expect("lancement de Chromium");
    // Même navigateur tant qu'il est connecté.
    assert!(Arc::ptr_eq(&browser, &get_qlik_browser().await.unwrap()));

    let lignes = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let copie = lignes.clone();
    let mut page = PageQlik::ouvrir(
        browser,
        Box::new(move |t: &str| {
            copie.lock().push(t.to_string());
            t.starts_with("[cf]").then(|| format!("[test][page] {t}"))
        }),
        Some("[test][pageerror]"),
    )
    .await
    .expect("page");

    page.identifiants_http("user", "secret").await.unwrap();
    page.ajouter_cookie("X-Qlik-Session", "valeur-de-session", "localhost").await.unwrap();
    let mut jeton = page.capturer_jeton_csrf().await.unwrap();
    let mut appels = page.exposer_fonction("cfCheckpoint").await.unwrap();

    page.aller(&format!("http://localhost:{port}/"), Duration::from_secs(20)).await.expect("navigation");
    let j = super::playwright::attendre_jeton(&mut jeton).await;
    assert_eq!(j.as_deref(), Some("jeton/secret"), "jeton CSRF capturé depuis l'URL du websocket");

    // Cookie posé avant navigation (Network.setCookies) et renvoyé au serveur.
    let texte = page.evaluer("() => document.getElementById('cookie').textContent", &json!(null)).await.unwrap();
    assert_eq!(texte, json!("X-Qlik-Session=valeur-de-session"));

    // Liaison exposée : appelée par la page, reçue côté Rust ; la promesse se résout à true.
    let r = page
        .evaluer(
            "async ({ n }) => { const ok = await window.cfCheckpoint({ rows: [[\"C1\", n]] }); return { ok, n: n * 2, nan: NaN }; }",
            &json!({ "n": 21 }),
        )
        .await
        .unwrap();
    assert_eq!(r, json!({ "ok": true, "n": 42, "nan": null }));
    let payload = tokio::time::timeout(Duration::from_secs(5), appels.recv()).await.unwrap().unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&payload).unwrap(), json!({ "rows": [["C1", 21]] }));

    // Exception in-page → erreur.
    let err = page.evaluer("() => { throw new Error('boum'); }", &json!(null)).await.unwrap_err().to_string();
    assert!(err.contains("boum"), "{err}");

    // Script embarqué de la recherche, avec ses vrais arguments JSON : le
    // websocket Engine (wss) échoue ici faute de Qlik, et le script le dit.
    let args = json!({
        "app": "abc", "dim": "yesCP", "token": "jeton", "terme": "tapis bain", "limite": 40, "settleMs": 10,
        "serialsDate": [46000, 46001], "mCa": "a", "mQte": "b", "mNbMag": "c", "mCaMag": "d", "mMarge": "e",
        "champCodeAlt": "article_no_centrale", "champsLibellePreferes": ["Article"], "champsFournisseurPreferes": ["Fournisseur"],
        "champLibelleForce": "", "champFournisseurForce": ""
    });
    let res = tokio::time::timeout(Duration::from_secs(40), page.evaluer(include_str!("js/recherche.js"), &args)).await.unwrap().unwrap();
    assert_eq!(res["ok"], json!(false), "{res}");
    assert!(res["error"].as_str().unwrap().starts_with("ws "), "{res}");

    // Script d'extraction : même chose, avec un jeu d'arguments complet.
    let args = json!({
        "app": "abc", "dim": "yesCP", "mca": "a", "mqte": "b", "mnb": "c", "mcamag": "d", "mmarge": "e",
        "codes": ["10000167303"], "token": "jeton", "monthlyPayload": [], "noDateMode": true,
        "qlikSettleMs": 10, "qlikCode15MaxAttempts": 1, "qlikArticleBatchFallbacks": [150, 75, 50],
        "selectAllCodes": true, "monthDim": true, "moisDimId": "pfGAwTs", "mqteComp": "x", "yearN": 2026,
        "useExpr": true, "exprQte": "Sum(quantite)", "exprCa": "Sum(ca_ht)", "exprNbMag": "Count(DISTINCT [Magasin Code])",
        "exprMarge": "Sum(marge)", "champsDateCandidats": ["Date"], "fournisseurCode": "", "champsFournisseurCandidats": ["code_fournisseur"],
        "couvertureFournisseurMin": 0.99
    });
    let res = tokio::time::timeout(Duration::from_secs(40), page.evaluer(include_str!("js/extraction.js"), &args)).await.unwrap().unwrap();
    assert_eq!(res["ok"], json!(false), "{res}");
    assert_eq!(res["rows"], json!([]));

    tokio::time::sleep(Duration::from_millis(300)).await;
    let vues = lignes.lock().clone();
    assert!(vues.iter().any(|l| l == "[cf] bonjour depuis la page 42"), "{vues:?}");
    assert!(vues.iter().any(|l| l == "bruit du client Qlik"), "{vues:?}");

    // Défi d'authentification HTTP : identifiants fournis automatiquement.
    page.aller(&format!("http://localhost:{port}/protege"), Duration::from_secs(20)).await.expect("navigation protégée");
    let corps = page.evaluer("() => document.body.textContent", &json!(null)).await.unwrap();
    assert_eq!(corps, json!("autorisé Basic dXNlcjpzZWNyZXQ="));

    page.fermer().await;
}

#[tokio::test]
async fn file_qlik_sequentielle() {
    let ordre = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let mut taches = Vec::new();
    for i in 0..4 {
        let ordre = ordre.clone();
        taches.push(tokio::spawn(async move {
            dans_la_file_qlik(&format!("tâche {i}"), || async move {
                ordre.lock().push(format!("début {i}"));
                tokio::time::sleep(Duration::from_millis(20)).await;
                ordre.lock().push(format!("fin {i}"));
                i
            })
            .await
        }));
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    for (i, t) in taches.into_iter().enumerate() {
        assert_eq!(t.await.unwrap(), i);
    }
    let o = ordre.lock().clone();
    // Jamais deux tâches en même temps, dans l'ordre d'arrivée.
    let attendu: Vec<String> = (0..4).flat_map(|i| [format!("début {i}"), format!("fin {i}")]).collect();
    assert_eq!(o, attendu);
}
