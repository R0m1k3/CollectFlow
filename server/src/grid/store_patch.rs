//! Complément des chiffres d'un magasin par l'API FF (ventes mensuelles) — partie
//! pure de `src/features/grid/lib/store-patch.ts`.
//!
//! Le calcul SQL de la Grille peut manquer les ventes d'un magasin pour certains
//! articles (quantité à 0 pour ce magasin). L'API FF les connaît : on en tire,
//! pour ces articles seulement, les séries et totaux du magasin.
//!
//! `buildStorePatchEntries` (qui lit les entrées mensuelles de l'API FF) viendra
//! avec le calcul de la grille (phase 2).

use super::types::{ProductRow, StorePatchEntry};
use std::collections::HashMap;

/// Articles à compléter : connus de FF (noid) et sans aucune vente SQL dans ce magasin.
pub fn store_patch_candidates<'a>(rows: &'a [ProductRow], magasin: &str) -> Vec<&'a ProductRow> {
    rows.iter()
        .filter(|row| {
            row.noid.map(|n| n != 0.0 && !n.is_nan()).unwrap_or(false)
                && row.quantite_by_store.as_ref().and_then(|m| m.get(magasin)).copied().unwrap_or(0.0) == 0.0
        })
        .collect()
}

/// Application historique, côté serveur (`/api/grid/rows?magasin=…`) : corrige le
/// magasin ET reporte les écarts sur les totaux « tous magasins » de la ligne.
/// Renvoie le nombre de lignes corrigées.
pub fn apply_store_patch_in_place(rows: &mut [ProductRow], magasin: &str, periods: &[String], entries: &[StorePatchEntry]) -> usize {
    let par_code: HashMap<&str, &StorePatchEntry> = entries.iter().map(|e| (e.codein.as_str(), e)).collect();
    let mut corrigees = 0;
    for row in rows.iter_mut() {
        let Some(e) = par_code.get(row.codein.as_str()) else { continue };

        let sales = row.sales12m_by_store.get_or_insert_with(Default::default).entry(magasin.to_string()).or_default();
        let mut deltas_ventes = Vec::with_capacity(periods.len());
        for period in periods {
            let current = sales.get(period).copied().unwrap_or(0.0);
            let next = e.sales.get(period).copied().unwrap_or(0.0);
            sales.insert(period.clone(), next);
            deltas_ventes.push((period, next - current));
        }
        let receptions = row.receptions12m_by_store.get_or_insert_with(Default::default).entry(magasin.to_string()).or_default();
        for period in periods {
            receptions.insert(period.clone(), e.receptions.get(period).copied().unwrap_or(0.0));
        }
        let stock = row.stock12m_by_store.get_or_insert_with(Default::default).entry(magasin.to_string()).or_default();
        for period in periods {
            stock.insert(period.clone(), e.stock.get(period).copied().unwrap_or(0.0));
        }
        for (period, delta) in deltas_ventes {
            let v = row.sales12m.get(period).copied().unwrap_or(0.0);
            row.sales12m.insert(period.clone(), v + delta);
        }

        let ca_by_store = row.ca_by_store.get_or_insert_with(Default::default);
        let quantite_by_store = row.quantite_by_store.get_or_insert_with(Default::default);
        let marge_by_store = row.marge_by_store.get_or_insert_with(Default::default);
        let delta_qty = e.quantite - quantite_by_store.get(magasin).copied().unwrap_or(0.0);
        let delta_ca = e.ca - ca_by_store.get(magasin).copied().unwrap_or(0.0);
        let delta_marge = e.marge - marge_by_store.get(magasin).copied().unwrap_or(0.0);

        quantite_by_store.insert(magasin.to_string(), e.quantite);
        ca_by_store.insert(magasin.to_string(), e.ca);
        marge_by_store.insert(magasin.to_string(), e.marge);
        row.total_quantite += delta_qty;
        row.total_ca += delta_ca;
        row.total_marge += delta_marge;
        row.taux_marge = if row.total_ca > 0.0 { (row.total_marge / row.total_ca) * 100.0 } else { 0.0 };
        if !row.working_stores.iter().any(|s| s == magasin) {
            row.working_stores.push(magasin.to_string());
        }
        corrigees += 1;
    }
    corrigees
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complement_reporte_sur_les_totaux() {
        let periods = vec!["202601".to_string(), "202602".to_string()];
        let mut row = ProductRow { codein: "A1".into(), noid: Some(7.0), ..Default::default() };
        row.sales12m.insert("202601".into(), 4.0);
        row.total_quantite = 4.0;
        row.total_ca = 40.0;
        row.total_marge = 10.0;
        row.working_stores = vec!["292".into()];
        let mut q = std::collections::BTreeMap::new();
        q.insert("292".to_string(), 4.0);
        row.quantite_by_store = Some(q);
        assert_eq!(store_patch_candidates(std::slice::from_ref(&row), "579").len(), 1);
        assert_eq!(store_patch_candidates(std::slice::from_ref(&row), "292").len(), 0);

        let mut e = StorePatchEntry { codein: "A1".into(), quantite: 3.0, ca: 30.0, marge: 6.0, ..Default::default() };
        e.sales.insert("202602".into(), 3.0);
        e.stock.insert("202601".into(), 5.0);
        let mut rows = vec![row];
        assert_eq!(apply_store_patch_in_place(&mut rows, "579", &periods, &[e]), 1);
        let r = &rows[0];
        assert_eq!(r.total_quantite, 7.0);
        assert_eq!(r.total_ca, 70.0);
        assert!((r.taux_marge - 16.0 / 70.0 * 100.0).abs() < 1e-9);
        assert_eq!(r.sales12m["202602"], 3.0);
        assert_eq!(r.sales12m_by_store.as_ref().unwrap()["579"]["202601"], 0.0);
        assert_eq!(r.stock12m_by_store.as_ref().unwrap()["579"]["202601"], 5.0);
        assert_eq!(r.working_stores, vec!["292".to_string(), "579".to_string()]);
    }
}
