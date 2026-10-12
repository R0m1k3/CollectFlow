//! Routes `/api/v1` adossées au calcul de la grille (phase 2) : `/grid`,
//! `/products/search`, `/products/{codein}`, `/products/{codein}/gamme`,
//! `/gammes`, `/fournisseurs`, `/network/{codeCentrale}`.

use super::api_gammes::{affecter_gammes, lire_corps_json};
use super::api_schemas::{
    parse_fournisseurs_query, parse_gammes_batch_body, parse_grid_query, parse_product_detail, parse_product_gamme_body,
    parse_product_search, pick_fields, query_map, to_sort_key, GridQueryParams,
};
use super::enrich::enrich_rows;
use super::product_rows::{attendre_persistance, get_product_rows, GetProductRowsInput};
use super::store::{
    get_grid_freshness, get_grid_row_by_codein, list_grid_suppliers, list_grid_suppliers_for_codein, query_grid_rows, GridFreshness,
    GridQuery, SortOrder,
};
use super::types::ProductRow;
use crate::api_v1_response::{build_pagination, fail, ok, ApiErrorCode};
use crate::auth::ApiAuth;
use crate::error::AppError;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use futures::channel::mpsc;
use futures::SinkExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

fn interne(e: AppError) -> Response {
    fail(ApiErrorCode::InternalError, e.message, None)
}

fn meta(entrees: Vec<(&str, Value)>) -> Option<Map<String, Value>> {
    Some(entrees.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// Lignes prêtes à sérialiser : enrichies (`enrich=1`) puis projetées (`fields`).
async fn lignes_json(rows: Vec<ProductRow>, enrichir: bool, fields: Option<&str>) -> Vec<Value> {
    let valeurs: Vec<Value> = if enrichir {
        enrich_rows(rows).await.into_iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect()
    } else {
        rows.into_iter().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)).collect()
    };
    valeurs.into_iter().map(|v| pick_fields(v, fields)).collect()
}

fn ordre(order: &str) -> Option<SortOrder> {
    Some(if order == "asc" { SortOrder::Asc } else { SortOrder::Desc })
}

/// `GET /api/v1/grid?fournisseur=…&gamme=&code1..3=&search=&sort=&order=&page=&limit=&fields=&compute=`
///
/// Lignes de grille d'un fournisseur, filtrées / triées / paginées **en SQL** depuis
/// l'instantané persisté (`grid_rows`).
///
/// Si le fournisseur n'a pas encore d'instantané, l'endpoint le **calcule à la demande**
/// (`compute=1`, défaut) ; `compute=0` restaure le comportement strict : échec
/// immédiat en `202 not_ready`.
pub async fn get_grid(ApiAuth(auth): ApiAuth, Query(params): Query<Vec<(String, String)>>) -> Response {
    let q = match parse_grid_query(&query_map(params)) {
        Ok(q) => q,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Paramètres invalides.", Some(issues.to_json())),
    };

    // Distingue « fournisseur jamais calculé » de « filtres sans résultat » (200 vide).
    let mut freshness = match get_grid_freshness(&q.fournisseur).await {
        Ok(f) => f,
        Err(e) => return interne(e),
    };
    let mut computed_on_demand = false;

    if freshness.is_none() {
        if q.compute == "0" {
            return fail(
                ApiErrorCode::NotReady,
                format!(
                    "Aucun instantané pour le fournisseur « {} ». Relancez sans « compute=0 » pour le calculer à la demande.",
                    q.fournisseur
                ),
                Some(json!({ "fournisseur": q.fournisseur })),
            );
        }

        tracing::info!("[api/v1/grid] instantané absent pour {} — calcul à la demande (via {})", q.fournisseur, auth.via);
        // magasin TOTAL : c'est la seule variante persistée par getProductRows,
        // et ProductRow embarque déjà les ventilations par magasin.
        match get_product_rows(GetProductRowsInput::total(&q.fournisseur, false)).await {
            // La persistance est lancée en arrière-plan par le calcul : on attend
            // qu'elle soit écrite avant de relire l'instantané.
            Ok(_) => attendre_persistance(&q.fournisseur).await,
            Err(e) => {
                tracing::error!("[api/v1/grid] calcul à la demande KO pour {}: {e:#}", q.fournisseur);
                return fail(
                    ApiErrorCode::InternalError,
                    format!("Le calcul de la grille a échoué pour le fournisseur « {} ».", q.fournisseur),
                    Some(json!({ "fournisseur": q.fournisseur })),
                );
            }
        }

        freshness = match get_grid_freshness(&q.fournisseur).await {
            Ok(f) => f,
            Err(e) => return interne(e),
        };
        if freshness.is_none() {
            // Calcul réussi mais aucune ligne : le code fournisseur n'existe pas, ou
            // il n'a aucun article. À distinguer d'une panne.
            return fail(
                ApiErrorCode::NotFound,
                format!("Aucun article pour le fournisseur « {} ». Vérifiez le code auprès de /api/v1/fournisseurs.", q.fournisseur),
                Some(json!({ "fournisseur": q.fournisseur })),
            );
        }
        computed_on_demand = true;
    }
    let freshness = freshness.unwrap_or(GridFreshness { row_count: 0, computed_at: None });

    let filtres = GridQuery {
        code_fournisseur: Some(q.fournisseur.clone()),
        gamme: q.gamme.clone(),
        code1: q.code1.clone(),
        code2: q.code2.clone(),
        code3: q.code3.clone(),
        nomenclature: q.nomenclature.clone(),
        search: q.search.clone(),
        sort: to_sort_key(q.sort.sort.as_deref()),
        order: ordre(&q.sort.order),
        page: None,
        limit: None,
    };

    // Sans `limit`, la réponse peut porter tout un fournisseur — et certains en
    // comptent plus de 130 000. On diffuse par lots, à mémoire constante.
    let Some(limit) = q.limit else {
        return stream_all_rows(filtres, q, freshness, computed_on_demand);
    };

    let result = match query_grid_rows(&GridQuery { page: Some(q.page), limit: Some(limit), ..filtres }).await {
        Ok(r) => r,
        Err(e) => return interne(e),
    };
    let enrichi = q.sort.enrich == "1";
    let nb = result.rows.len();
    let rows = lignes_json(result.rows, enrichi, q.sort.fields.as_deref()).await;
    let pagination = build_pagination(q.page, limit, result.total);
    let has_more = pagination.has_more;

    let mut m = meta(vec![
        ("fournisseur", json!(q.fournisseur)),
        ("computedAt", json!(result.computed_at)),
        ("snapshotComputedAt", json!(freshness.computed_at)),
        ("snapshotRowCount", json!(freshness.row_count)),
        ("enrichi", json!(enrichi)),
        // true = l'instantané n'existait pas et vient d'être calculé par cet appel.
        ("computedOnDemand", json!(computed_on_demand)),
        // true = cette réponse contient **toutes** les lignes du fournisseur.
        ("complet", json!(!has_more)),
    ])
    .unwrap_or_default();
    if has_more {
        m.insert(
            "avertissement".into(),
            json!(format!(
                "Réponse partielle : {nb} lignes sur {}, parce que « limit » a été précisé. Retirez « limit » pour obtenir tout le fournisseur en un appel, ou passez à page={}.",
                result.total,
                q.page + 1
            )),
        );
    }
    ok(rows, Some(pagination), Some(m))
}

/// Lots internes : compromis entre nombre d'allers-retours SQL et mémoire retenue.
const STREAM_BATCH: i64 = 1000;

/// Diffuse **toutes** les lignes du fournisseur en une seule réponse JSON, sans
/// jamais la construire entièrement en mémoire.
///
/// La forme reste celle des autres réponses (`{ data, pagination, meta }`) ;
/// `pagination` et `meta` sont écrits en dernier, une fois le total connu. Une
/// erreur survenant après les premiers octets ne peut plus changer le code HTTP :
/// on ferme alors le document avec `meta.erreur`.
fn stream_all_rows(filtres: GridQuery, q: GridQueryParams, freshness: GridFreshness, computed_on_demand: bool) -> Response {
    let (mut tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(async move {
        let mut envoyees: i64 = 0;
        let mut total: i64 = 0;
        let mut computed_at: Option<String> = None;
        let mut erreur: Option<String> = None;
        let enrichi = q.sort.enrich == "1";

        if tx.send(Ok(Bytes::from_static(b"{\"data\":["))).await.is_err() {
            return;
        }
        let mut page = 1;
        loop {
            let lot = match query_grid_rows(&GridQuery { page: Some(page), limit: Some(STREAM_BATCH), ..filtres.clone() }).await {
                Ok(l) => l,
                Err(e) => {
                    erreur = Some(e.message);
                    break;
                }
            };
            if page == 1 {
                total = lot.total;
                computed_at = lot.computed_at.clone();
            }
            let n = lot.rows.len() as i64;
            if n == 0 {
                break;
            }
            let mut morceau = Vec::new();
            for r in lignes_json(lot.rows, enrichi, q.sort.fields.as_deref()).await {
                if envoyees > 0 {
                    morceau.push(b',');
                }
                morceau.extend(serde_json::to_vec(&r).unwrap_or_default());
                envoyees += 1;
            }
            if tx.send(Ok(Bytes::from(morceau))).await.is_err() {
                return;
            }
            if n < STREAM_BATCH {
                break;
            }
            page += 1;
        }
        if let Some(e) = &erreur {
            tracing::error!("[api/v1/grid] diffusion interrompue pour {} après {envoyees} lignes: {e}", q.fournisseur);
        }

        let complet = erreur.is_none() && envoyees == total;
        let mut meta = json!({
            "fournisseur": q.fournisseur,
            "computedAt": computed_at,
            "snapshotComputedAt": freshness.computed_at,
            "snapshotRowCount": freshness.row_count,
            "enrichi": enrichi,
            "computedOnDemand": computed_on_demand,
            "diffuse": true,
            "complet": complet,
        });
        if let Some(e) = erreur {
            meta["erreur"] = json!(format!("Diffusion interrompue après {envoyees} lignes sur {total} : {e}"));
        }
        let fin = json!({
            "pagination": { "page": 1, "limit": envoyees, "total": total, "totalPages": 1, "hasMore": !complet },
            "meta": meta,
        });
        let texte = serde_json::to_string(&fin).unwrap_or_default();
        let _ = tx.send(Ok(Bytes::from(format!("],{}", &texte[1..])))).await;
    });

    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            // Empêche un proxy de tamponner la réponse entière avant de la relayer.
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(rx),
    )
        .into_response()
}

/// `GET /api/v1/products/search?q=…&fournisseur=&gamme=&sort=&order=&page=&limit=&fields=`
///
/// **Recherche transversale** sur libellé, codein, GTIN, référence et code centrale —
/// tous fournisseurs confondus. Lit uniquement l'instantané `grid_rows`.
pub async fn get_products_search(ApiAuth(_auth): ApiAuth, Query(params): Query<Vec<(String, String)>>) -> Response {
    let q = match parse_product_search(&query_map(params)) {
        Ok(q) => q,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Paramètres invalides.", Some(issues.to_json())),
    };
    let result = match query_grid_rows(&GridQuery {
        code_fournisseur: q.fournisseur.clone(),
        gamme: q.gamme.clone(),
        search: Some(q.q.clone()),
        sort: to_sort_key(q.sort.sort.as_deref()),
        order: ordre(&q.sort.order),
        page: Some(q.page),
        limit: Some(q.limit),
        ..Default::default()
    })
    .await
    {
        Ok(r) => r,
        Err(e) => return interne(e),
    };
    let enrichi = q.sort.enrich == "1";
    let total = result.total;
    let computed_at = result.computed_at.clone();
    let rows = lignes_json(result.rows, enrichi, q.sort.fields.as_deref()).await;
    ok(
        rows,
        Some(build_pagination(q.page, q.limit, total)),
        meta(vec![
            ("query", json!(q.q)),
            ("computedAt", json!(computed_at)),
            ("scope", json!(q.fournisseur.as_ref().map(|f| format!("fournisseur:{f}")).unwrap_or_else(|| "tous fournisseurs".into()))),
            ("enrichi", json!(enrichi)),
        ]),
    )
}

/// `GET /api/v1/products/{codein}?fournisseur=…`
///
/// Fiche complète d'un produit, enrichie des métriques réseau Qlik lues **en cache**.
/// `fournisseur` lève l'ambiguïté d'un article référencé chez plusieurs fournisseurs ;
/// sans lui, l'instantané le plus récent est renvoyé.
pub async fn get_product(ApiAuth(_auth): ApiAuth, Path(codein): Path<String>, Query(params): Query<Vec<(String, String)>>) -> Response {
    if codein.is_empty() {
        return fail(ApiErrorCode::BadRequest, "Paramètre 'codein' requis.", None);
    }
    let parsed = match parse_product_detail(&query_map(params)) {
        Ok(p) => p,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Paramètres invalides.", Some(issues.to_json())),
    };

    let mut found = match get_grid_row_by_codein(&codein, parsed.fournisseur.as_deref()).await {
        Ok(f) => f,
        Err(e) => return interne(e),
    };

    // Absent de l'instantané : on peut le calculer, mais seulement si l'appelant a
    // précisé le fournisseur — le calcul se fait par lot fournisseur, pas par article.
    if found.is_none() && parsed.compute == "1" {
        if let Some(f) = parsed.fournisseur.as_deref() {
            tracing::info!("[api/v1/products] {codein} absent — calcul du lot {f} à la demande");
            let calcul = async {
                get_product_rows(GetProductRowsInput::total(f, false)).await?;
                attendre_persistance(f).await;
                get_grid_row_by_codein(&codein, Some(f)).await.map_err(|e| anyhow::anyhow!(e.message))
            };
            match calcul.await {
                Ok(r) => found = r,
                Err(e) => tracing::error!("[api/v1/products] calcul KO pour {f}: {e:#}"),
            }
        }
    }

    let Some(found) = found else {
        return fail(
            ApiErrorCode::NotFound,
            match &parsed.fournisseur {
                Some(f) => format!("Produit « {codein} » introuvable chez le fournisseur « {f} »."),
                None => format!(
                    "Aucun instantané pour le produit « {codein} ». Ajoutez « fournisseur=… » pour que l'API calcule le lot à la demande."
                ),
            },
            None,
        );
    };

    // Métriques réseau + gamme serveur relues maintenant : le payload date du dernier
    // calcul de la grille, alors que ces deux données évoluent indépendamment.
    let Some(enriched) = enrich_rows(vec![found.row]).await.into_iter().next() else {
        return fail(ApiErrorCode::InternalError, "Enrichissement impossible.", None);
    };
    let network_fetched_at = enriched.network.as_ref().and_then(|n| n.fetched_at.clone());
    let has_network = enriched.network.is_some();
    ok(
        enriched,
        None,
        meta(vec![
            ("computedAt", json!(found.computed_at)),
            ("networkFetchedAt", json!(network_fetched_at)),
            ("hasNetwork", json!(has_network)),
        ]),
    )
}

fn maintenant_iso() -> String {
    crate::db::iso_utc(chrono::Utc::now())
}

/// `PUT /api/v1/products/{codein}/gamme`   `{ "gamme": "A", "fournisseur"?: "…" }`
///
/// Propose une gamme pour un article. La proposition reste **à valider** dans la
/// Grille. `fournisseur` n'est requis que si l'article est référencé chez plusieurs
/// fournisseurs, ou s'il n'apparaît pas encore dans l'instantané.
pub async fn put_product_gamme(ApiAuth(auth): ApiAuth, Path(codein): Path<String>, body: Bytes) -> Response {
    if codein.is_empty() {
        return fail(ApiErrorCode::BadRequest, "Paramètre 'codein' requis.", None);
    }
    let corps = match lire_corps_json(&body) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let parsed = match parse_product_gamme_body(&corps) {
        Ok(p) => p,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Corps de requête invalide.", Some(issues.to_json())),
    };

    let fournisseur = match parsed.fournisseur {
        Some(f) => f,
        None => {
            let fournisseurs = match list_grid_suppliers_for_codein(&codein).await {
                Ok(f) => f,
                Err(e) => return interne(e),
            };
            if fournisseurs.is_empty() {
                return fail(
                    ApiErrorCode::NotFound,
                    format!(
                        "Aucun instantané pour le produit « {codein} ». Ajoutez « fournisseur » au corps de la requête pour que l'API calcule le lot à la demande."
                    ),
                    None,
                );
            }
            if fournisseurs.len() > 1 {
                return fail(
                    ApiErrorCode::BadRequest,
                    format!("Le produit « {codein} » est référencé chez plusieurs fournisseurs : précisez « fournisseur »."),
                    Some(json!({ "fournisseurs": fournisseurs })),
                );
            }
            fournisseurs[0].code_fournisseur.clone()
        }
    };

    let res = match affecter_gammes(&fournisseur, &[(codein, parsed.gamme)], parsed.compute, &auth.subject).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let mut data = match res.resultats.first().map(serde_json::to_value) {
        Some(Ok(Value::Object(m))) => m,
        _ => Map::new(),
    };
    data.insert("codeFournisseur".into(), json!(res.code_fournisseur));
    data.insert("nomFournisseur".into(), json!(res.nom_fournisseur));
    ok(Value::Object(data), None, meta(vec![("enregistreLe", json!(maintenant_iso()))]))
}

/// `POST /api/v1/gammes`   `{ "fournisseur": "…", "changes": [{ "codein": "…", "gamme": "A" }, …] }`
///
/// Propose la gamme de plusieurs articles d'un fournisseur en un appel, à valider
/// dans la Grille. Tout ou rien : un article inconnu chez le fournisseur fait
/// échouer l'appel (404).
pub async fn post_gammes(ApiAuth(auth): ApiAuth, body: Bytes) -> Response {
    let corps = match lire_corps_json(&body) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let parsed = match parse_gammes_batch_body(&corps) {
        Ok(p) => p,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Corps de requête invalide.", Some(issues.to_json())),
    };
    let changes: Vec<(String, String)> = parsed.changes.into_iter().map(|c| (c.codein, c.gamme)).collect();
    let res = match affecter_gammes(&parsed.fournisseur, &changes, parsed.compute, &auth.subject).await {
        Ok(r) => r,
        Err(r) => return r,
    };
    let demandes = res.resultats.len();
    let modifies = res.resultats.iter().filter(|r| r.modifie).count();
    let a_valider = res.resultats.iter().filter(|r| r.statut == "a_valider").count();
    ok(
        &res.resultats,
        None,
        meta(vec![
            ("codeFournisseur", json!(res.code_fournisseur)),
            ("nomFournisseur", json!(res.nom_fournisseur)),
            ("demandes", json!(demandes)),
            ("modifies", json!(modifies)),
            ("aValider", json!(a_valider)),
            ("enregistreLe", json!(maintenant_iso())),
        ]),
    )
}

/// `GET /api/v1/fournisseurs?search=…&withData=1`
///
/// Liste des fournisseurs : tout le référentiel (`fouident`), enrichi de la
/// fraîcheur de l'instantané de grille quand il existe. `withData=1` restreint aux
/// seuls fournisseurs déjà présents dans l'instantané.
pub async fn get_fournisseurs(ApiAuth(_auth): ApiAuth, Query(params): Query<Vec<(String, String)>>) -> Response {
    let parsed = match parse_fournisseurs_query(&query_map(params)) {
        Ok(p) => p,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Paramètres invalides.", Some(issues.to_json())),
    };
    let snapshot = match list_grid_suppliers().await {
        Ok(s) => s,
        Err(e) => return interne(e),
    };

    if parsed.with_data.as_deref() == Some("1") {
        let term = parsed.search.as_ref().map(|s| s.to_lowercase());
        let data: Vec<Value> = snapshot
            .iter()
            .filter(|s| match &term {
                None => true,
                Some(t) => {
                    s.code_fournisseur.to_lowercase().contains(t.as_str())
                        || s.nom_fournisseur.as_deref().unwrap_or("").to_lowercase().contains(t.as_str())
                }
            })
            .map(|s| {
                json!({ "code": s.code_fournisseur, "nom": s.nom_fournisseur, "hasSnapshot": true, "rowCount": s.row_count, "computedAt": s.computed_at })
            })
            .collect();
        let total = data.len();
        return ok(data, None, meta(vec![("total", json!(total)), ("scope", json!("instantané uniquement"))]));
    }

    let by_code: HashMap<&str, &super::store::GridSupplier> = snapshot.iter().map(|s| (s.code_fournisseur.as_str(), s)).collect();
    let fournisseurs = crate::ff::pg::pg_get_fournisseurs(parsed.search.as_deref()).await;
    let data: Vec<Value> = fournisseurs
        .iter()
        .map(|f| {
            let snap = by_code.get(f.code.as_str());
            json!({
                "code": f.code,
                "nom": f.nom,
                "hasSnapshot": snap.is_some(),
                "rowCount": snap.map(|s| s.row_count).unwrap_or(0),
                "computedAt": snap.and_then(|s| s.computed_at.clone()),
            })
        })
        .collect();
    let total = data.len();
    ok(data, None, meta(vec![("total", json!(total)), ("withSnapshot", json!(by_code.len()))]))
}

/// `GET /api/v1/network/{codeCentrale}`
///
/// Métriques réseau Qlik d'un produit et sa courbe de quantités mensuelles.
/// Lecture **exclusive** de la table `qlik_network_metrics` : aucun appel à Qlik.
pub async fn get_network(ApiAuth(_auth): ApiAuth, Path(code_centrale): Path<String>) -> Response {
    if code_centrale.is_empty() {
        return fail(ApiErrorCode::BadRequest, "Paramètre 'codeCentrale' requis.", None);
    }
    let metrics = match crate::qlik::network_cache::get_network_metrics_by_code_centrale(std::slice::from_ref(&code_centrale)).await {
        Ok(m) => m,
        Err(e) => return fail(ApiErrorCode::InternalError, format!("{e:#}"), None),
    };
    let Some(found) = metrics.get(&code_centrale) else {
        return fail(
            ApiErrorCode::NotFound,
            format!(
                "Aucune donnée réseau en cache pour le code centrale « {code_centrale} ». Lancez une synchronisation Qlik ou une recherche réseau."
            ),
            None,
        );
    };
    let mut data = Map::new();
    data.insert("codeCentrale".into(), json!(code_centrale));
    if let Ok(Value::Object(m)) = serde_json::to_value(found) {
        data.extend(m);
    }
    ok(Value::Object(data), None, meta(vec![("fetchedAt", json!(found.fetched_at)), ("source", json!("cache"))]))
}
