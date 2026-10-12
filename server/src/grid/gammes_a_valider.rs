//! CollectFlow — Gammes proposées par l'API, en attente de validation
//! (port de `src/lib/gammes-a-valider.ts`).
//!
//! L'API `/api/v1` ne change plus une gamme directement : elle dépose une
//! proposition, que la Grille affiche comme une modification non enregistrée.
//! L'utilisateur voit ainsi quels produits changent de gamme, puis valide
//! (« Enregistrer ») ou rejette (« Annuler les modifications »).

use crate::db;
use crate::error::AppResult;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropositionGamme {
    pub codein: String,
    /// Gamme proposée.
    pub gamme: String,
    /// Gamme enregistrée au moment de la proposition.
    pub gamme_precedente: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GammeAValider {
    pub codein: String,
    /// Gamme proposée.
    pub gamme: String,
    /// Gamme enregistrée au moment de la proposition.
    pub gamme_precedente: Option<String>,
    pub auteur: Option<String>,
    /// Date ISO de la proposition.
    pub proposee_le: String,
}

/// Dépose des propositions (la dernière l'emporte pour un même article) et retire
/// celles des articles `annules` — redemander la gamme déjà enregistrée annule la
/// proposition en attente.
pub async fn proposer_gammes(code_fournisseur: &str, propositions: &[PropositionGamme], annules: &[String], auteur: &str) -> AppResult<()> {
    let pool = db::pool()?;
    let mut tx = pool.begin().await?;
    if !annules.is_empty() {
        sqlx::query("delete from gammes_a_valider where code_fournisseur = $1 and codein = any($2)")
            .bind(code_fournisseur)
            .bind(annules)
            .execute(&mut *tx)
            .await?;
    }
    if !propositions.is_empty() {
        let maintenant = chrono::Utc::now().naive_utc();
        let auteur: String = auteur.chars().take(100).collect();
        let mut qb: QueryBuilder<Postgres> =
            QueryBuilder::new("insert into gammes_a_valider (code_fournisseur, codein, gamme, gamme_precedente, auteur, created_at) ");
        qb.push_values(propositions, |mut b, p| {
            b.push_bind(code_fournisseur.to_string())
                .push_bind(p.codein.clone())
                .push_bind(p.gamme.clone())
                .push_bind(p.gamme_precedente.clone())
                .push_bind(auteur.clone())
                .push_bind(maintenant);
        });
        qb.push(
            " on conflict (code_fournisseur, codein) do update set gamme = excluded.gamme, \
             gamme_precedente = excluded.gamme_precedente, auteur = excluded.auteur, created_at = excluded.created_at",
        );
        qb.build().execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Propositions en attente pour un fournisseur.
pub async fn lister_gammes_a_valider(code_fournisseur: &str) -> AppResult<Vec<GammeAValider>> {
    let pool = db::pool()?;
    let rows = sqlx::query(
        "select code_fournisseur, codein, gamme, gamme_precedente, auteur, created_at from gammes_a_valider \
         where code_fournisseur = $1",
    )
    .bind(code_fournisseur)
    .fetch_all(&pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| GammeAValider {
            codein: r.try_get("codein").unwrap_or_default(),
            gamme: r.try_get("gamme").unwrap_or_default(),
            gamme_precedente: r.try_get("gamme_precedente").ok().flatten(),
            auteur: r.try_get("auteur").ok().flatten(),
            proposee_le: r.try_get::<NaiveDateTime, _>("created_at").map(db::iso).unwrap_or_default(),
        })
        .collect())
}

/// Propositions en attente pour une liste d'articles, indexées par `fournisseur|codein`.
pub async fn gammes_a_valider_par_article(codeins: &[String]) -> AppResult<HashMap<String, String>> {
    if codeins.is_empty() {
        return Ok(HashMap::new());
    }
    let pool = db::pool()?;
    let rows = sqlx::query("select code_fournisseur, codein, gamme from gammes_a_valider where codein = any($1)")
        .bind(codeins)
        .fetch_all(&pool)
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let f: String = r.try_get("code_fournisseur").unwrap_or_default();
            let c: String = r.try_get("codein").unwrap_or_default();
            (format!("{f}|{c}"), r.try_get("gamme").unwrap_or_default())
        })
        .collect())
}

/// Retire des propositions, une fois validées ou rejetées dans la Grille.
pub async fn supprimer_gammes_a_valider(code_fournisseur: &str, codeins: &[String]) -> AppResult<()> {
    if codeins.is_empty() {
        return Ok(());
    }
    let pool = db::pool()?;
    sqlx::query("delete from gammes_a_valider where code_fournisseur = $1 and codein = any($2)")
        .bind(code_fournisseur)
        .bind(codeins)
        .execute(&pool)
        .await?;
    Ok(())
}
