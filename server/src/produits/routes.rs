//! Routes HTTP et page du module `produits` :
//! - `/api/produits/search` (port de `src/app/api/produits/search/route.ts`) ;
//! - `/api/produits/opportunites` (port de `src/app/api/produits/opportunites/route.ts`) ;
//! - page `produit-fiche` (données de l'ancienne page serveur `/produits`).

use super::fiche::{get_produit_fiche, get_produit_fiche_by_code_centrale};
use super::search::{demarrer_recherche, etat_recherche, RechercheEtat};
use crate::auth::SessionUser;
use crate::error::{AppError, AppResult};
use crate::ff::api::build_last12_months_range;
use crate::ff::pg::pg_get_opportunites_famille;
use crate::grid::js::{js_number_from_str, js_trim};
use crate::rpc::{json, Ctx};
use axum::extract::Query;
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Nombre de produits de la famille renvoyés (30 dans le code d'origine).
const LIMITE_OPPORTUNITES: i64 = 30;

const TERME_TROP_COURT: &str = "Saisissez au moins 3 caractères";

/// Terme de recherche (`q`), `None` s'il fait moins de 3 caractères.
fn lire_terme(q: &HashMap<String, String>) -> Option<String> {
    let terme = js_trim(q.get("q").map(|s| s.as_str()).unwrap_or(""));
    (terme.encode_utf16().count() >= 3).then(|| terme.to_string())
}

/// Recherche produit **Qlik d'abord** — API asynchrone.
///
/// `POST /api/produits/search?q=<terme>[&force=1]` démarre la recherche et rend la
/// main tout de suite. `GET /api/produits/search?q=<terme>` renvoie l'avancement,
/// puis le résultat.
///
/// Pourquoi asynchrone : une recherche enchaîne deux allers-retours Qlik (dont une
/// extraction mensuelle) et peut dépasser la minute. Une requête HTTP maintenue
/// aussi longtemps se fait couper par le reverse proxy, qui répond une page
/// d'erreur **HTML** — le client échouait alors sur « Unexpected token '<' … is
/// not valid JSON ». Même schéma que `POST /api/qlik/sync`.
///
/// Contrôle de session explicite : il répond ici en JSON, et relit le compte en
/// base (cf. `auth::authz`).
pub async fn search_post(_session: SessionUser, Query(q): Query<HashMap<String, String>>) -> AppResult<Json<Value>> {
    let Some(terme) = lire_terme(&q) else {
        return Err(AppError::bad_request(TERME_TROP_COURT));
    };
    let force = q.get("force").map(|s| s.as_str()) == Some("1");
    let job = demarrer_recherche(&terme, force);
    Ok(Json(RechercheEtat::Job(job).reponse()))
}

/// `GET /api/produits/search?q=<terme>` — état de la recherche (polling client).
pub async fn search_get(_session: SessionUser, Query(q): Query<HashMap<String, String>>) -> AppResult<Json<Value>> {
    let Some(terme) = lire_terme(&q) else {
        return Err(AppError::bad_request(TERME_TROP_COURT));
    };
    Ok(Json(etat_recherche(&terme).reponse()))
}

/// GET /api/produits/opportunites?nomNoId=123
///
/// Produits de la même nomenclature, classés par écart entre performance réseau
/// et performance locale (quantités par magasin). Chargé à la demande depuis la
/// fiche produit : la requête agrège `mvtart` sur 12 mois pour toute la famille,
/// on ne veut pas la payer au chargement de la page.
pub async fn opportunites(_session: SessionUser, Query(q): Query<HashMap<String, String>>) -> AppResult<Json<Value>> {
    let raw = q.get("nomNoId").map(|s| s.as_str()).unwrap_or("");
    let nom_no_id = js_number_from_str(raw);
    if !nom_no_id_valide(raw, nom_no_id) {
        return Err(AppError::bad_request("Param 'nomNoId' invalide"));
    }

    // `pg_get_opportunites_famille` avale déjà ses erreurs (liste vide, journalisée).
    let periode = build_last12_months_range();
    let rows = pg_get_opportunites_famille(nom_no_id as i64, &periode.date_debut, &periode.date_fin, LIMITE_OPPORTUNITES).await;
    Ok(Json(json!({ "success": true, "rows": rows })))
}

/// `!raw || !Number.isInteger(nomNoId) || nomNoId <= 0` → invalide.
fn nom_no_id_valide(raw: &str, n: f64) -> bool {
    !raw.is_empty() && n.is_finite() && n.fract() == 0.0 && n > 0.0
}

/// Page `produit-fiche` : `?codein=…` → `getProduitFiche(codein)`,
/// `?cc=…` → `getProduitFicheByCodeCentrale(cc)`, sinon `null`.
pub async fn page_produit_fiche(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    let codein = js_trim(ctx.query.get("codein").map(|s| s.as_str()).unwrap_or(""));
    let code_centrale = js_trim(ctx.query.get("cc").map(|s| s.as_str()).unwrap_or(""));

    let fiche = if !codein.is_empty() {
        get_produit_fiche(codein).await?
    } else if !code_centrale.is_empty() {
        get_produit_fiche_by_code_centrale(code_centrale).await?
    } else {
        None
    };
    json(fiche)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(q: &str) -> HashMap<String, String> {
        HashMap::from([("q".to_string(), q.to_string())])
    }

    #[test]
    fn terme_minimum_3_caracteres() {
        assert_eq!(lire_terme(&params("  ab  ")), None);
        assert_eq!(lire_terme(&HashMap::new()), None);
        assert_eq!(lire_terme(&params(" poê ")), Some("poê".to_string()));
    }

    #[test]
    fn nom_no_id_comme_number_is_integer() {
        let ok = |s: &str| nom_no_id_valide(s, js_number_from_str(s));
        assert!(ok("123"));
        assert!(ok(" 12 "));
        assert!(ok("12.0"));
        assert!(ok("0x10"));
        assert!(!ok(""));
        assert!(!ok("  "));
        assert!(!ok("0"));
        assert!(!ok("-3"));
        assert!(!ok("1.5"));
        assert!(!ok("abc"));
        assert!(!ok("Infinity"));
    }
}
