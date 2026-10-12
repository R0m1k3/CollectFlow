//! Client PostgreSQL FF Nancy (port de `src/lib/pg-ff-client.ts`) — À PORTER.
//!
//! Contrat minimal fixé d'avance (utilisé par le module `qlik`) : la structure
//! [`PgArticle`] et [`pg_get_articles_by_fournisseur`]. Le reste du fichier est
//! à porter ; garder ces deux signatures (champs ajoutables).

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgArticle {
    pub no_id: i64,
    pub codein: String,
    /// Code centrale = articles.artcentrale (format 10000XXXXXX) — clé jointure Qlik « Article Code ».
    #[serde(rename = "codeCentrale", skip_serializing_if = "Option::is_none")]
    pub code_centrale: Option<String>,
    pub codefou: String,
}

/// Tous les articles d'un fournisseur (une requête). Erreur SQL propagée.
pub async fn pg_get_articles_by_fournisseur(_codefou: &str) -> anyhow::Result<Vec<PgArticle>> {
    anyhow::bail!("pg_get_articles_by_fournisseur : pas encore porté")
}
