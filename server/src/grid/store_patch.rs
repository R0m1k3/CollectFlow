//! Complément des chiffres d'un magasin par l'API FF (ventes mensuelles) — partie
//! pure de `src/features/grid/lib/store-patch.ts`.
//!
//! Le calcul SQL de la Grille peut manquer les ventes d'un magasin pour certains
//! articles (quantité à 0 pour ce magasin). L'API FF les connaît : on en tire,
//! pour ces articles seulement, les séries et totaux du magasin.

use super::types::{ProductRow, StorePatchEntry};
use crate::ff::api::FfMensuelEntry;
use crate::ff::js::js_number_or0;
use std::collections::HashMap;

/// Chiffres du magasin tirés de l'API, pour les articles où elle montre des ventes.
///
/// `retenus` : codes article des candidats retenus (cf. [`store_patch_candidates`]).
pub fn build_store_patch_entries(
    retenus: &[String],
    magasin: &str,
    periods: &[String],
    mensuel: &HashMap<String, Vec<FfMensuelEntry>>,
) -> Vec<StorePatchEntry> {
    struct Valeurs {
        qty: f64,
        ca: f64,
        marge: f64,
        stock: f64,
        receptions: f64,
    }
    let mut resultat = Vec::new();
    for codein in retenus {
        let entries: Vec<&FfMensuelEntry> =
            mensuel.get(codein).map(|v| v.iter().filter(|e| e.site == magasin).collect()).unwrap_or_default();
        if entries.is_empty() {
            continue;
        }

        let mut by_period: HashMap<String, Valeurs> = HashMap::new();
        for entry in entries {
            let period = entry.mois.replacen('-', "", 1);
            if !periods.contains(&period) {
                continue;
            }
            let ventes = entry.ventes.as_ref();
            // qte_vendue / ca_ht sont NÉGATIFS côté API (ventes nettes) : on
            // les nie au lieu de Math.abs pour que les retours restent déduits.
            let qty = -ventes.map(|v| js_number_or0(&v.qte_vendue)).unwrap_or(0.0);
            let ca = -ventes.map(|v| js_number_or0(&v.ca_ht)).unwrap_or(0.0);
            let marge = ventes.map(|v| js_number_or0(&v.marge)).unwrap_or(0.0);
            let stock = js_number_or0(&entry.stock_fin_mois);
            let receptions = entry.receptions.as_ref().map(|r| js_number_or0(&r.qte_recue)).unwrap_or(0.0);
            by_period.insert(period, Valeurs { qty, ca, marge, stock, receptions });
        }

        let api_qty: f64 = by_period.values().map(|v| v.qty).sum();
        if api_qty == 0.0 {
            continue;
        }

        let mut e = StorePatchEntry { codein: codein.clone(), ..Default::default() };
        let mut last_stock = 0.0;
        for period in periods {
            let value = by_period.get(period);
            e.sales.insert(period.clone(), value.map(|v| v.qty).unwrap_or(0.0));
            e.receptions.insert(period.clone(), value.map(|v| v.receptions).unwrap_or(0.0));
            if let Some(v) = value {
                last_stock = v.stock;
            }
            e.stock.insert(period.clone(), last_stock);
            e.quantite += value.map(|v| v.qty).unwrap_or(0.0);
            e.ca += value.map(|v| v.ca).unwrap_or(0.0);
            e.marge += value.map(|v| v.marge).unwrap_or(0.0);
        }
        resultat.push(e);
    }
    resultat
}

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
    fn complement_depuis_l_api() {
        let periods = vec!["202601".to_string(), "202602".to_string(), "202603".to_string()];
        let entree = |mois: &str, site: &str, qte: &str| -> FfMensuelEntry {
            serde_json::from_value(serde_json::json!({
                "mois": mois, "site": site, "stock_fin_mois": "5.000",
                "ventes": { "qte_vendue": qte, "ca_ht": "-26.66", "marge": "12.76" }, "receptions": null
            }))
            .unwrap()
        };
        let mut mensuel = HashMap::new();
        mensuel.insert(
            "A1".to_string(),
            vec![entree("2026-01", "292", "-2.000"), entree("2026-02", "579", "-9"), entree("2025-01", "292", "-4")],
        );
        mensuel.insert("A2".to_string(), vec![entree("2026-01", "292", "0")]);
        let e = build_store_patch_entries(&["A1".into(), "A2".into(), "A3".into()], "292", &periods, &mensuel);
        assert_eq!(e.len(), 1, "A2 sans vente, A3 sans donnée");
        assert_eq!(e[0].quantite, 2.0);
        assert!((e[0].ca - 26.66).abs() < 1e-9);
        assert_eq!(e[0].sales["202602"], 0.0);
        assert_eq!(e[0].stock["202603"], 5.0, "stock reporté");
        assert_eq!(serde_json::to_value(&e[0]).unwrap()["receptions"], serde_json::json!({ "202601": 0, "202602": 0, "202603": 0 }));
    }

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
