//! Données des anciennes pages serveur du module FF (`GET /api/pages/{nom}`) :
//! accueil, ventes par mois, meilleures ventes, stocks à surveiller,
//! commandes fournisseurs et publicités.

use super::actions::lister_cadences;
use super::api::{avec_cle_ff, get_ff_api_base};
use super::cache::get_fournisseurs_cached;
use super::js::{get, js_number, js_number_to_string, message_erreur};
use super::pg::{
    completer_fournisseurs, pg_get_ca_by_fournisseur, pg_get_ca_by_nomenclature, pg_get_commandes_auto, pg_get_dashboard_data, pg_get_hit_parade,
    pg_get_sans_vente_6_mois, pg_get_stock_negatif, pg_get_stock_sans_vente, PgCommandeAutoRow,
};
use crate::error::{AppError, AppResult};
use crate::ff_cache::{cached, CacheOpts};
use crate::rpc::{json, Ctx};
use chrono::{Datelike, Local, NaiveDate};
use serde::Serialize;
use serde_json::{json as json_value, Value};
use std::time::Duration;

/// Message d'erreur affiché par l'ancien `ErrorState`.
fn erreur_page(e: anyhow::Error) -> AppError {
    AppError::internal(message_erreur(&e))
}

// ---------------------------------------------------------------------------
// Accueil
// ---------------------------------------------------------------------------

/// `pgGetDashboardData()`, gardé 30 minutes : ce sont les ventes de la veille,
/// elles ne changent pas dans la journée.
pub async fn page_dashboard(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    let opts = CacheOpts { ttl: Some(Duration::from_secs(30 * 60)), cache_if: None };
    match cached("dashboard-data", opts, || async { pg_get_dashboard_data().await }).await {
        Ok(d) => json(d),
        Err(e) => {
            tracing::error!("[Dashboard] pgGetDashboardData failed: {}", message_erreur(&e));
            let msg: String = message_erreur(&e).chars().take(500).collect();
            Err(AppError::internal(msg))
        }
    }
}

// ---------------------------------------------------------------------------
// Ventes par mois
// ---------------------------------------------------------------------------

/// « YYYY-MM » d'une date.
fn format_mois(d: NaiveDate) -> String {
    format!("{}-{:02}", d.year(), d.month())
}

/// Calcul du mois N-1 (même mois année précédente).
pub fn get_mois_n1(mois: &str) -> String {
    let mut parts = mois.split('-').map(|p| p.trim().parse::<i32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(year), Some(month)) => {
            // new Date(year, month - 13) : -13 mois, débordements normalisés.
            let total = year * 12 + (month - 13);
            let (y, m0) = (total.div_euclid(12), total.rem_euclid(12));
            format!("{y}-{:02}", m0 + 1)
        }
        _ => "NaN-NaN".to_string(),
    }
}

/// Lignes de `pgGetCaByFournisseur` (mode `fournisseur`) ou
/// `pgGetCaByNomenclature` (toute autre valeur), mises en cache.
pub async fn page_analytics(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    // Toute autre valeur que « fournisseur » affichait déjà la vue par famille.
    let mode_fournisseur = ctx.q("mode").unwrap_or("fournisseur") == "fournisseur";

    // Mois par défaut = dernier mois complet (le mois précédent) : le mois en
    // cours, incomplet, se comparerait mal à un mois N-1 entier.
    let today = Local::now().date_naive();
    let premier = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
    let dernier_mois_complet = format_mois(premier.pred_opt().unwrap_or(premier));
    let mois = ctx.q("mois").map(|s| s.to_string()).unwrap_or(dernier_mois_complet);
    let mois_n1 = ctx.q("moisN1").map(|s| s.to_string()).unwrap_or_else(|| get_mois_n1(&mois));

    let res = if mode_fournisseur {
        let (m, n1) = (mois.clone(), mois_n1.clone());
        cached(&format!("ca-fournisseur:{mois}:{mois_n1}"), CacheOpts::default(), move || async move {
            pg_get_ca_by_fournisseur(&m, &n1).await
        })
        .await
        .and_then(|rows| Ok(serde_json::to_value(rows)?))
    } else {
        let (m, n1) = (mois.clone(), mois_n1.clone());
        cached(&format!("ca-nomenclature:{mois}:{mois_n1}"), CacheOpts::default(), move || async move {
            pg_get_ca_by_nomenclature(&m, &n1).await
        })
        .await
        .and_then(|rows| Ok(serde_json::to_value(rows)?))
    };
    res.map_err(|e| {
        tracing::error!("[analytics] chargement impossible : {}", message_erreur(&e));
        erreur_page(e)
    })
}

// ---------------------------------------------------------------------------
// Meilleures ventes
// ---------------------------------------------------------------------------

/// Lignes de `pgGetHitParade(debut, fin)` (par défaut : du 1er du mois à aujourd'hui).
pub async fn page_hit_parade(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    let today = Local::now().date_naive();
    let first_of_month = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
    let date_debut = ctx.q("debut").map(|s| s.to_string()).unwrap_or_else(|| first_of_month.format("%Y-%m-%d").to_string());
    let date_fin = ctx.q("fin").map(|s| s.to_string()).unwrap_or_else(|| today.format("%Y-%m-%d").to_string());

    let (d, f) = (date_debut.clone(), date_fin.clone());
    match cached(&format!("hit-parade:{date_debut}:{date_fin}"), CacheOpts::default(), move || async move {
        let mut rows = pg_get_hit_parade(&d, &f).await?;
        completer_fournisseurs(&mut rows, |r| (r.codein.as_str(), &mut r.fournisseur)).await;
        anyhow::Ok(rows)
    })
    .await
    {
        Ok(rows) => json(rows),
        Err(e) => {
            tracing::error!("[hit-parade] chargement impossible : {}", message_erreur(&e));
            Err(erreur_page(e))
        }
    }
}

// ---------------------------------------------------------------------------
// Stocks à surveiller
// ---------------------------------------------------------------------------

/// `{ rowsNegatif, rowsSansVente, rowsSansVente6Mois }` pour un magasin (ou tous).
pub async fn page_stock_negatif(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    let magasin = ctx.q("magasin").unwrap_or("").to_string();

    // Données FF recopiées chaque nuit : mises en cache (cf. ff_cache).
    let site = if magasin.is_empty() { None } else { Some(magasin.clone()) };
    let (s1, s2, s3) = (site.clone(), site.clone(), site);
    let (k1, k2, k3) =
        (format!("stock-negatif:{magasin}"), format!("stock-sans-vente:{magasin}"), format!("stock-sans-vente-6-mois:{magasin}"));
    let res = tokio::try_join!(
        cached(&k1, CacheOpts::default(), move || async move {
            let mut rows = pg_get_stock_negatif(s1.as_deref()).await?;
            completer_fournisseurs(&mut rows, |r| (r.codein.as_str(), &mut r.fournisseur)).await;
            anyhow::Ok(rows)
        }),
        cached(&k2, CacheOpts::default(), move || async move {
            let mut rows = pg_get_stock_sans_vente(s2.as_deref()).await?;
            completer_fournisseurs(&mut rows, |r| (r.codein.as_str(), &mut r.fournisseur)).await;
            anyhow::Ok(rows)
        }),
        cached(&k3, CacheOpts::default(), move || async move {
            let mut rows = pg_get_sans_vente_6_mois(s3.as_deref()).await?;
            completer_fournisseurs(&mut rows, |r| (r.codein.as_str(), &mut r.fournisseur)).await;
            anyhow::Ok(rows)
        }),
    );
    match res {
        Ok((rows_negatif, rows_sans_vente, rows_sans_vente_6_mois)) => Ok(json_value!({
            "rowsNegatif": rows_negatif,
            "rowsSansVente": rows_sans_vente,
            "rowsSansVente6Mois": rows_sans_vente_6_mois,
        })),
        Err(e) => {
            tracing::error!("[stock-negatif] chargement impossible : {}", message_erreur(&e));
            Err(erreur_page(e))
        }
    }
}

// ---------------------------------------------------------------------------
// Commandes fournisseurs
// ---------------------------------------------------------------------------

/// `{ rows, cadences, fournisseurs }`.
pub async fn page_commandes_auto(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    let (rows, cadences, fournisseurs) = tokio::join!(
        // Propositions de l'API FF (un appel, plus un par fournisseur sans franco) :
        // gardées 2 minutes, pour que chaque modification du cadencier — qui
        // recharge la page — n'attende pas de nouveau toute l'API.
        cached(
            "commandes-auto",
            CacheOpts { ttl: Some(Duration::from_secs(2 * 60)), cache_if: Some(|rows: &Vec<PgCommandeAutoRow>| !rows.is_empty()) },
            || async { anyhow::Ok(pg_get_commandes_auto().await) },
        ),
        lister_cadences(),
        get_fournisseurs_cached(),
    );
    Ok(json_value!({
        "rows": rows.map_err(erreur_page)?,
        "cadences": cadences,
        "fournisseurs": fournisseurs.map_err(erreur_page)?,
    }))
}

// ---------------------------------------------------------------------------
// Publicités
// ---------------------------------------------------------------------------

const PAGE_SIZE: u32 = 50;
/// Délai maximal d'un appel à l'API FF : sans lui, une API muette figeait la page.
const FF_API_TIMEOUT: Duration = Duration::from_millis(15_000);
/// Réponses de l'API gardées 10 minutes (les erreurs ne le sont jamais) : la liste
/// et l'historique étaient re-téléchargés à chaque clic sur un filtre ou une page.
const PUB_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize)]
struct PublicitesResult {
    data: Value,
    total: f64,
    pages: f64,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct HistoriqueResult {
    data: Value,
    error: Option<String>,
}

fn client_publicites() -> reqwest::Client {
    reqwest::Client::builder().timeout(FF_API_TIMEOUT).build().unwrap_or_default()
}

async fn fetch_publicites_api(statut: String, page: String) -> PublicitesResult {
    let mut params: Vec<(&str, String)> = vec![("page", page), ("limit", PAGE_SIZE.to_string())];
    if !statut.is_empty() && statut != "toutes" {
        params.push(("statut", statut));
    }
    let base = get_ff_api_base().await;
    let res = async {
        let req = client_publicites()
            .get(format!("{base}/api/publicites"))
            .query(&params)
            .header(reqwest::header::CACHE_CONTROL, "no-store");
        let res = avec_cle_ff(req).await.send().await?;
        if !res.status().is_success() {
            return anyhow::Ok(PublicitesResult {
                data: json_value!([]),
                total: 0.0,
                pages: 0.0,
                error: Some(format!(
                    "Erreur API: {} {}",
                    res.status().as_u16(),
                    super::api::status_text(res.status())
                )),
            });
        }
        let body: Value = res.json().await?;
        let champ = |k: &str| get(&body, k).filter(|v| !v.is_null());
        Ok(PublicitesResult {
            data: champ("publicites").cloned().unwrap_or_else(|| json_value!([])),
            total: champ("total").map(js_number).unwrap_or(0.0),
            pages: champ("pages").map(js_number).unwrap_or(0.0),
            error: None,
        })
    }
    .await;
    res.unwrap_or_else(|e| PublicitesResult {
        data: json_value!([]),
        total: 0.0,
        pages: 0.0,
        error: Some(format!("Impossible de joindre l'API: {}", message_erreur(&e))),
    })
}

async fn fetch_historique_api() -> HistoriqueResult {
    let base = get_ff_api_base().await;
    let res = async {
        let req = client_publicites()
            .get(format!("{base}/api/publicites/historique"))
            .header(reqwest::header::CACHE_CONTROL, "no-store");
        let res = avec_cle_ff(req).await.send().await?;
        if !res.status().is_success() {
            return anyhow::Ok(HistoriqueResult {
                data: json_value!([]),
                error: Some(format!("Erreur historique: {}", res.status().as_u16())),
            });
        }
        let body: Value = res.json().await?;
        Ok(HistoriqueResult {
            data: get(&body, "publicites").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json_value!([])),
            error: None,
        })
    }
    .await;
    res.unwrap_or_else(|e| HistoriqueResult { data: json_value!([]), error: Some(format!("Impossible de joindre l'API: {}", message_erreur(&e))) })
}

/// `{ publicites, total, pages, erreurPublicites?, historique, erreurHistorique?, pageSize }`.
pub async fn page_publicites(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    let statut = ctx.query.get("statut").cloned().unwrap_or_else(|| "toutes".into());
    // Math.max(1, Number(page) || 1)
    let page_num = {
        let n = ctx.query.get("page").map(|p| js_number(&Value::String(p.clone()))).unwrap_or(f64::NAN);
        let n = if n.is_nan() || n == 0.0 { 1.0 } else { n };
        n.max(1.0)
    };
    let page = js_number_to_string(page_num);

    let (s, p) = (statut.clone(), page.clone());
    let cle = format!("publicites:{statut}:{page}");
    let (pub_result, histo_result) = tokio::join!(
        cached(
            &cle,
            CacheOpts { ttl: Some(PUB_CACHE_TTL), cache_if: Some(|r: &PublicitesResult| r.error.is_none()) },
            move || async move { anyhow::Ok(fetch_publicites_api(s, p).await) },
        ),
        cached(
            "publicites-historique",
            CacheOpts { ttl: Some(PUB_CACHE_TTL), cache_if: Some(|r: &HistoriqueResult| r.error.is_none()) },
            || async { anyhow::Ok(fetch_historique_api().await) },
        ),
    );
    let pub_result = pub_result.map_err(erreur_page)?;
    let histo_result = histo_result.map_err(erreur_page)?;

    let mut out = serde_json::Map::new();
    out.insert("publicites".into(), pub_result.data);
    out.insert("total".into(), json_value!(pub_result.total));
    out.insert("pages".into(), json_value!(pub_result.pages));
    if let Some(e) = pub_result.error {
        out.insert("erreurPublicites".into(), Value::String(e));
    }
    out.insert("historique".into(), histo_result.data);
    if let Some(e) = histo_result.error {
        out.insert("erreurHistorique".into(), Value::String(e));
    }
    out.insert("pageSize".into(), json_value!(PAGE_SIZE));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mois_n1() {
        assert_eq!(get_mois_n1("2026-03"), "2025-03");
        assert_eq!(get_mois_n1("2026-12"), "2025-12");
        assert_eq!(get_mois_n1("2026-01"), "2025-01");
        assert_eq!(get_mois_n1("abc"), "NaN-NaN");
    }
}
