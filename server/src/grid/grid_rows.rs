//! Routes internes de la Grille (ports de `src/app/api/grid/rows/route.ts` et
//! `src/app/api/grid/rows/store-patch/route.ts`).

use super::js::JsNum;
use super::product_rows::{get_product_rows, get_store_patch, GetProductRowsInput};
use super::types::ProductRow;
use crate::auth::SessionUser;
use axum::body::{Body, Bytes};
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::channel::mpsc;
use futures::SinkExt;
use serde::Serialize;
use serde_json::json;

/// `searchParams.get(nom)` : première occurrence.
pub fn premier<'a>(params: &'a [(String, String)], nom: &str) -> Option<&'a str> {
    params.iter().find(|(k, _)| k == nom).map(|(_, v)| v.as_str())
}

#[derive(Serialize)]
struct Lot<'a> {
    #[serde(rename = "type")]
    type_: &'static str,
    rows: &'a [ProductRow],
    loaded: JsNum,
    total: usize,
}

/// Indice de `Array.prototype.slice` (troncature, bornage à la longueur).
fn indice_slice(x: f64, len: usize) -> usize {
    if x.is_nan() {
        0
    } else {
        x.trunc().clamp(0.0, len as f64) as usize
    }
}

fn ndjson(v: &impl Serialize) -> Bytes {
    let mut out = serde_json::to_vec(v).unwrap_or_default();
    out.push(b'\n');
    Bytes::from(out)
}

/// `GET /api/grid/rows?fournisseur=…&magasin=…&chunkSize=…&refresh=1`
///
/// Flux NDJSON : `{ type: "start" }`, puis des lots `{ type: "chunk", rows, loaded,
/// total }`, puis `{ type: "done" }` — ou `{ type: "error", error }`.
pub async fn get_grid_rows(SessionUser(_utilisateur): SessionUser, Query(params): Query<Vec<(String, String)>>) -> Response {
    let Some(code_fournisseur) = premier(&params, "fournisseur").filter(|f| !f.is_empty()).map(str::to_string) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Missing fournisseur" }))).into_response();
    };
    let magasin = premier(&params, "magasin").unwrap_or("TOTAL").to_string();
    let chunk_size = {
        let brut = premier(&params, "chunkSize").map(super::js::js_number_from_str).unwrap_or(150.0);
        // Math.max(50, Math.min(500, x)) : NaN se propage.
        if brut.is_nan() {
            f64::NAN
        } else {
            brut.clamp(50.0, 500.0)
        }
    };
    // `code1`/`code2`/`code3` ne sont pas lus : la Grille filtre en local
    // (getProductRows ne s'en sert pas).
    let force_refresh = premier(&params, "refresh") == Some("1");

    // Client parti (changement de fournisseur, page quittée) : on arrête de
    // sérialiser et d'envoyer. Le calcul lui-même continue — il est partagé et
    // mis en cache, la prochaine ouverture en profitera.
    let (mut tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(async move {
        if tx.send(Ok(ndjson(&json!({ "type": "start", "loaded": 0, "total": null })))).await.is_err() {
            return;
        }
        let input = GetProductRowsInput { code_fournisseur, magasin: Some(magasin), force_refresh };
        match get_product_rows(input).await {
            Ok(shared) => {
                let total = shared.len();
                let mut start = 0.0f64;
                while start < total as f64 {
                    let ligne = {
                        let rows = shared.rows.read();
                        let len = rows.len();
                        let (a, b) = (indice_slice(start, len), indice_slice(start + chunk_size, len));
                        let lot = &rows[a..b.max(a)];
                        ndjson(&Lot { type_: "chunk", rows: lot, loaded: JsNum((start + lot.len() as f64).min(total as f64)), total })
                    };
                    if tx.send(Ok(ligne)).await.is_err() {
                        return;
                    }
                    start += chunk_size;
                    tokio::task::yield_now().await;
                }
                let _ = tx.send(Ok(ndjson(&json!({ "type": "done", "loaded": total, "total": total })))).await;
            }
            Err(e) => {
                let _ = tx.send(Ok(ndjson(&json!({ "type": "error", "error": e.to_string() })))).await;
            }
        }
    });

    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(rx),
    )
        .into_response()
}

/// `GET /api/grid/rows/store-patch?fournisseur=…&magasin=…`
///
/// Complément de l'API FF pour un magasin (cf. `store_patch`). La Grille charge
/// toujours les lignes « tous magasins » et applique ce complément à son arrivée :
/// le changement de magasin n'attend plus rien.
pub async fn get_grid_store_patch(SessionUser(_utilisateur): SessionUser, Query(params): Query<Vec<(String, String)>>) -> Response {
    let code_fournisseur = premier(&params, "fournisseur").unwrap_or("");
    let magasin = premier(&params, "magasin").unwrap_or("");
    // Un code inconnu ferait de chaque article un candidat : autant d'appels
    // inutiles à l'API FF. « Tous magasins » n'a pas de complément.
    if code_fournisseur.is_empty() || !crate::domain::MAGASINS.iter().any(|m| m.code == magasin) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Paramètres fournisseur et magasin requis." }))).into_response();
    }
    match get_store_patch(code_fournisseur, magasin).await {
        Ok(patch) => ([(header::CACHE_CONTROL, "no-store")], Json(&*patch)).into_response(),
        Err(e) => {
            tracing::error!("[store-patch] {code_fournisseur}/{magasin} KO: {}", crate::error::short(&e, 200));
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": "Complément indisponible." }))).into_response()
        }
    }
}
