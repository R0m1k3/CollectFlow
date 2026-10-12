//! Lectures FF partagées par plusieurs pages, mises en cache
//! (port de `getFournisseursCached` / `getDerniereReceptionCached` de `src/lib/ff-cache.ts`).

use super::pg::{pg_get_derniere_reception_par_fournisseur, pg_get_fournisseurs, CodeNom};
use crate::ff_cache::{cached, CacheOpts};
use std::collections::{BTreeSet, HashMap};

/// Référentiel fournisseurs (Grille, cadencier). Vide = erreur avalée, non gardé.
pub async fn get_fournisseurs_cached() -> anyhow::Result<Vec<CodeNom>> {
    cached(
        "fournisseurs",
        CacheOpts { ttl: None, cache_if: Some(|rows: &Vec<CodeNom>| !rows.is_empty()) },
        || async { anyhow::Ok(pg_get_fournisseurs(None).await) },
    )
    .await
}

/// Dernière réception par fournisseur et magasin, pour les fournisseurs du
/// cadencier seulement : de loin la lecture la plus lourde de la page Commandes.
/// Clé = liste triée, donc recalculée quand une cadence est ajoutée ou retirée.
/// Vide = erreur avalée (ou aucune réception), non gardé.
pub async fn get_derniere_reception_cached(codes: &[String]) -> anyhow::Result<HashMap<String, String>> {
    let liste: Vec<String> = codes.iter().map(|c| c.trim().to_string()).collect::<BTreeSet<_>>().into_iter().collect();
    if liste.is_empty() {
        return Ok(HashMap::new());
    }
    let key = format!("derniere-reception:{}", liste.join(","));
    cached(
        &key,
        CacheOpts { ttl: None, cache_if: Some(|map: &HashMap<String, String>| !map.is_empty()) },
        move || async move { anyhow::Ok(pg_get_derniere_reception_par_fournisseur(Some(&liste)).await) },
    )
    .await
}
