//! Routes `/api/v1` du module qui ne dépendent que de l'instantané `grid_rows`
//! (phase 1) : `GET /api/v1/nomenclatures`.

use super::api_schemas::{parse_nomenclatures_query, query_map};
use super::store::{get_grid_freshness, list_grid_nomenclatures};
use crate::api_v1_response::{fail, ok, ApiErrorCode};
use crate::auth::ApiAuth;
use axum::extract::Query;
use axum::response::Response;
use serde_json::{json, Map, Value};

/// `GET /api/v1/nomenclatures?fournisseur=…&niveau=1|2|3&parent=…`
///
/// Répartition des articles d'un fournisseur par poste de nomenclature, avec le
/// nombre d'articles et le CA de chacun.
///
/// C'est la porte d'entrée pour traiter un gros fournisseur : certains dépassent
/// 130 000 articles, et tout récupérer d'un coup n'a de sens ni pour une IA ni
/// pour une application. On liste d'abord les postes — quelques dizaines de
/// lignes — puis on interroge `/grid?fournisseur=…&nomenclature=…` poste par poste.
///
/// Les codes sont hiérarchiques par préfixe (6 chiffres, de 31xxxx à 40xxxx) :
/// niveau 1 = « 32 », niveau 2 = « 3202 », niveau 3 = « 320211 ». `parent` accepte
/// un préfixe pour descendre l'arborescence sans tout charger.
pub async fn get_nomenclatures(ApiAuth(_auth): ApiAuth, Query(params): Query<Vec<(String, String)>>) -> Response {
    let params = query_map(params);
    let parsed = match parse_nomenclatures_query(&params) {
        Ok(p) => p,
        Err(issues) => return fail(ApiErrorCode::BadRequest, "Paramètres invalides.", Some(issues.to_json())),
    };
    let fournisseur = parsed.fournisseur;

    // Même distinction que /grid : « pas encore calculé » n'est pas « vide ».
    let freshness = match get_grid_freshness(&fournisseur).await {
        Ok(f) => f,
        Err(e) => return fail(ApiErrorCode::InternalError, e.message, None),
    };
    let Some(freshness) = freshness else {
        return fail(
            ApiErrorCode::NotReady,
            format!(
                "Aucun instantané pour le fournisseur « {fournisseur} ». Appelez /api/v1/grid?fournisseur={fournisseur} une fois pour le calculer."
            ),
            Some(json!({ "fournisseur": fournisseur })),
        );
    };

    let postes = match list_grid_nomenclatures(&fournisseur, parsed.niveau, parsed.parent.as_deref()).await {
        Ok(p) => p,
        Err(e) => return fail(ApiErrorCode::InternalError, e.message, None),
    };
    let nb_articles: i64 = postes.iter().map(|p| p.nb_articles).sum();

    let mut meta = Map::new();
    meta.insert("fournisseur".into(), json!(fournisseur));
    meta.insert("niveau".into(), json!(parsed.niveau));
    meta.insert("parent".into(), parsed.parent.map(Value::String).unwrap_or(Value::Null));
    meta.insert("nbPostes".into(), json!(postes.len()));
    // Total couvert par les postes listés — à rapprocher de snapshotRowCount.
    meta.insert("nbArticles".into(), json!(nb_articles));
    meta.insert("snapshotRowCount".into(), json!(freshness.row_count));
    meta.insert("snapshotComputedAt".into(), json!(freshness.computed_at));
    // Le paramètre de /grid à utiliser avec les `code` renvoyés ci-dessus.
    // `nomenclature` filtre par préfixe et fonctionne aux trois niveaux.
    meta.insert("filtreGrid".into(), json!("nomenclature"));

    ok(postes, None, Some(meta))
}
