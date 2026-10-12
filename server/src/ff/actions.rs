//! Actions du module FF : `getFournisseurs`, `getMagasins`
//! (`src/features/grid/actions.ts`) et le cadencier de commande
//! (`src/features/commandes-auto/actions.ts`).

use super::api::get_sites_from_api;
use super::cache::{get_derniere_reception_cached, get_fournisseurs_cached};
use super::js::{js_number, message_erreur};
use crate::db::pool;
use crate::error::AppResult;
use crate::rpc::{json, Ctx};
use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;

// ---------------------------------------------------------------------------
// Grille
// ---------------------------------------------------------------------------

/// Liste de tous les fournisseurs (PostgreSQL FF).
pub async fn get_fournisseurs(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    // Relu à chaque navigation dans la Grille (changement de fournisseur, de
    // magasin…) : le référentiel ne change qu'avec la recopie nocturne.
    json(get_fournisseurs_cached().await?)
}

/// Liste des magasins (sites).
pub async fn get_magasins(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    json(get_sites_from_api().await)
}

// ---------------------------------------------------------------------------
// Cadencier
// ---------------------------------------------------------------------------

/// Statut d'une cadence : "a_commander" | "bientot" | "ok" | "inconnu".
pub type CadenceStatut = &'static str;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CadenceView {
    pub id: i32,
    pub codefou: String,
    pub nomfou: String,
    pub site: String,
    pub intervalle_semaines: i32,
    pub actif: bool,
    /// Date ISO de la dernière réception, ou null si inconnue
    pub derniere_reception: Option<String>,
    /// Date ISO d'échéance (dernière réception + X semaines), ou null
    pub echeance: Option<String>,
    /// Jours restants avant l'échéance (négatif = en retard), ou null
    pub jours_restants: Option<i64>,
    pub statut: CadenceStatut,
}

const MS_PAR_JOUR: i64 = 24 * 60 * 60 * 1000;
/// Seuil (en jours) en dessous duquel une cadence passe en "bientôt à commander"
const SEUIL_BIENTOT_JOURS: i64 = 7;

fn calc_statut(jours_restants: Option<i64>) -> CadenceStatut {
    match jours_restants {
        None => "inconnu",
        Some(j) if j <= 0 => "a_commander",
        Some(j) if j <= SEUIL_BIENTOT_JOURS => "bientot",
        Some(_) => "ok",
    }
}

/// Liste des fournisseurs (référentiel) pour le sélecteur de cadence.
pub async fn get_fournisseurs_pour_cadence(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    json(get_fournisseurs_cached().await?)
}

struct CadenceRow {
    id: i32,
    code_fournisseur: String,
    nom_fournisseur: Option<String>,
    site: String,
    intervalle_semaines: i32,
    actif: bool,
}

/// Toutes les cadences enrichies du calcul d'échéance (sans contrôle d'accès).
/// Liste vide en cas d'erreur.
pub async fn lister_cadences() -> Vec<CadenceView> {
    let res = async {
        let rows = sqlx::query(
            "SELECT id, code_fournisseur, nom_fournisseur, site, intervalle_semaines, actif FROM commande_cadences",
        )
        .fetch_all(&pool()?)
        .await?;
        let rows: Vec<CadenceRow> = rows
            .iter()
            .map(|r| CadenceRow {
                id: r.try_get("id").unwrap_or_default(),
                code_fournisseur: r.try_get("code_fournisseur").unwrap_or_default(),
                nom_fournisseur: r.try_get("nom_fournisseur").unwrap_or_default(),
                site: r.try_get("site").unwrap_or_default(),
                intervalle_semaines: r.try_get("intervalle_semaines").unwrap_or_default(),
                actif: r.try_get("actif").unwrap_or_default(),
            })
            .collect();
        // Réceptions des seuls fournisseurs du cadencier : la lecture sur tout
        // l'historique de tous les fournisseurs était la plus lourde de la page.
        let codes: Vec<String> = rows.iter().map(|r| r.code_fournisseur.clone()).collect();
        let receptions = get_derniere_reception_cached(&codes).await?;
        anyhow::Ok((rows, receptions))
    }
    .await;
    let (rows, receptions) = match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[cadence] listCadences error: {}", message_erreur(&e));
            return vec![];
        }
    };

    let now = Local::now().with_timezone(&Utc).timestamp_millis();

    rows.into_iter()
        .map(|r| {
            let reception_iso = receptions.get(&format!("{}|{}", r.code_fournisseur, r.site)).cloned();

            let mut echeance_iso = None;
            let mut jours_restants = None;
            if let Some(iso) = reception_iso.as_deref() {
                if let Ok(d) = DateTime::parse_from_rfc3339(iso) {
                    let echeance = d.timestamp_millis() + r.intervalle_semaines as i64 * 7 * MS_PAR_JOUR;
                    echeance_iso = DateTime::<Utc>::from_timestamp_millis(echeance).map(crate::db::iso_utc);
                    jours_restants = Some(((echeance - now) as f64 / MS_PAR_JOUR as f64).ceil() as i64);
                }
            }

            CadenceView {
                id: r.id,
                nomfou: r.nom_fournisseur.clone().unwrap_or_else(|| r.code_fournisseur.clone()),
                codefou: r.code_fournisseur,
                site: r.site,
                intervalle_semaines: r.intervalle_semaines,
                actif: r.actif,
                derniere_reception: reception_iso,
                echeance: echeance_iso,
                jours_restants,
                statut: if r.actif { calc_statut(jours_restants) } else { "inconnu" },
            }
        })
        .collect()
}

/// Retourne toutes les cadences enrichies du calcul d'échéance à partir
/// de la dernière réception (FF Nancy).
pub async fn list_cadences(ctx: Ctx) -> AppResult<Value> {
    ctx.session().await?;
    json(lister_cadences().await)
}

/// Réponse des actions d'écriture du cadencier.
#[derive(Debug, Clone, Serialize)]
pub struct ResultatCadence {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ResultatCadence {
    fn ok() -> Self {
        Self { ok: true, error: None }
    }
    fn ko(error: Option<String>) -> Self {
        Self { ok: false, error }
    }
}

/// `Math.round` (arrondi vers +∞ pour les demis).
fn math_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Crée ou met à jour la cadence d'un fournisseur sur un site.
/// Entrée : `{ codefou, nomfou?, site, intervalleSemaines, actif? }`.
pub async fn upsert_cadence(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.session().await {
        return json(ResultatCadence::ko(Some(e.message)));
    }
    let input = ctx.raw(0);
    if !input.is_object() {
        return Err(crate::error::AppError::internal("Cannot read properties of undefined (reading 'codefou')"));
    }

    let texte = |k: &str| input.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string());
    let codefou = texte("codefou").unwrap_or_default();
    let site = texte("site").unwrap_or_default();
    let intervalle = math_round(js_number(input.get("intervalleSemaines").unwrap_or(&Value::Null)));
    // `input.intervalleSemaines` absent → Number(undefined) = NaN.
    let intervalle = if input.get("intervalleSemaines").is_none() { f64::NAN } else { intervalle };

    if codefou.is_empty() || site.is_empty() {
        return json(ResultatCadence::ko(Some("Fournisseur et magasin requis.".into())));
    }
    if !intervalle.is_finite() || !(1.0..=104.0).contains(&intervalle) {
        return json(ResultatCadence::ko(Some("L'intervalle doit être compris entre 1 et 104 semaines.".into())));
    }
    let nomfou: Option<String> = input.get("nomfou").and_then(|v| v.as_str()).map(|s| s.to_string());
    let actif = input.get("actif").and_then(|v| v.as_bool()).unwrap_or(true);

    let res = async {
        sqlx::query(
            r#"INSERT INTO commande_cadences (code_fournisseur, nom_fournisseur, site, intervalle_semaines, actif)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (code_fournisseur, site) DO UPDATE SET
                   nom_fournisseur = $2,
                   intervalle_semaines = $4,
                   actif = $5,
                   updated_at = $6"#,
        )
        .bind(&codefou)
        .bind(&nomfou)
        .bind(&site)
        .bind(intervalle as i32)
        .bind(actif)
        .bind(Local::now().naive_local())
        .execute(&pool()?)
        .await?;
        anyhow::Ok(())
    }
    .await;
    match res {
        Ok(()) => json(ResultatCadence::ok()),
        Err(e) => {
            tracing::error!("[cadence] upsertCadence error: {}", message_erreur(&e));
            json(ResultatCadence::ko(Some("Échec de l'enregistrement.".into())))
        }
    }
}

/// Active / désactive une cadence sans la supprimer.
/// Arguments : `(codefou, site, actif)`.
pub async fn toggle_cadence(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.session().await {
        return json(ResultatCadence::ko(Some(e.message)));
    }
    let codefou: String = ctx.arg(0)?;
    let site: String = ctx.arg(1)?;
    let actif: bool = ctx.arg(2)?;

    let res = async {
        sqlx::query("UPDATE commande_cadences SET actif = $1, updated_at = $2 WHERE code_fournisseur = $3 AND site = $4")
            .bind(actif)
            .bind(Local::now().naive_local())
            .bind(&codefou)
            .bind(&site)
            .execute(&pool()?)
            .await?;
        anyhow::Ok(())
    }
    .await;
    match res {
        Ok(()) => json(ResultatCadence::ok()),
        Err(e) => {
            tracing::error!("[cadence] toggleCadence error: {}", message_erreur(&e));
            json(ResultatCadence::ko(None))
        }
    }
}

/// Supprime définitivement une cadence.
/// Arguments : `(codefou, site)`.
pub async fn remove_cadence(ctx: Ctx) -> AppResult<Value> {
    if let Err(e) = ctx.session().await {
        return json(ResultatCadence::ko(Some(e.message)));
    }
    let codefou: String = ctx.arg(0)?;
    let site: String = ctx.arg(1)?;

    let res = async {
        sqlx::query("DELETE FROM commande_cadences WHERE code_fournisseur = $1 AND site = $2")
            .bind(&codefou)
            .bind(&site)
            .execute(&pool()?)
            .await?;
        anyhow::Ok(())
    }
    .await;
    match res {
        Ok(()) => json(ResultatCadence::ok()),
        Err(e) => {
            tracing::error!("[cadence] removeCadence error: {}", message_erreur(&e));
            json(ResultatCadence::ko(None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuts() {
        assert_eq!(calc_statut(None), "inconnu");
        assert_eq!(calc_statut(Some(0)), "a_commander");
        assert_eq!(calc_statut(Some(-3)), "a_commander");
        assert_eq!(calc_statut(Some(7)), "bientot");
        assert_eq!(calc_statut(Some(8)), "ok");
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-1.5), -1.0);
    }
}
