//! CollectFlow — Fiche produit — port de
//! `src/features/produits/api/get-produit-fiche.ts`
//! (`getProduitFiche`, `getProduitFicheByCodeCentrale`).

use super::types::{ProduitFiche, ProduitMois, ProduitTotaux, SerieMensuelle};
use crate::ff::api::build_last12_months_range;
use crate::ff::pg::{
    pg_get_codein_by_code_centrale, pg_get_commandes_by_codein, pg_get_fournisseurs_by_codein, pg_get_gamme_history_by_codein,
    pg_get_mensuel_by_codein, pg_get_produit_detail, pg_get_stock_by_codein, PgMensuelRow,
};
use crate::grid::js::js_trim;
use crate::grid::months::{get_last12_months, today};
use crate::qlik::get_network_metrics_by_code_centrale;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Les 12 clés de mois "YYYYMM" glissantes, mois courant exclu.
fn build_month_keys() -> Vec<String> {
    get_last12_months(today())
}

fn empty_mois(mois: &str) -> ProduitMois {
    ProduitMois { mois: mois.to_string(), qte: 0.0, ca: 0.0, marge: 0.0, stock_fin_mois: 0.0, qte_recue: 0.0 }
}

fn totaux_from<'a>(rows: impl Iterator<Item = &'a ProduitMois>) -> ProduitTotaux {
    let (mut qte, mut ca, mut marge) = (0.0, 0.0, 0.0);
    for r in rows {
        qte += r.qte;
        ca += r.ca;
        marge += r.marge;
    }
    ProduitTotaux { qte, ca, marge, taux_marge: if ca > 0.0 { (marge / ca) * 100.0 } else { 0.0 } }
}

/// Totaux d'une série sur les mois de la fenêtre, dans l'ordre de `months`.
fn totaux_serie(months: &[String], serie: &SerieMensuelle) -> ProduitTotaux {
    totaux_from(months.iter().filter_map(|m| serie.get(m)))
}

/// `Number(x) || 0`.
fn ou_zero(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        x
    }
}

/// Partie mensuelle de la fiche, calculée à partir des lignes `mvtart` agrégées.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mensuel {
    pub mensuel_total: SerieMensuelle,
    pub mensuel_par_site: BTreeMap<String, SerieMensuelle>,
    pub totaux: ProduitTotaux,
    pub totaux_par_site: BTreeMap<String, ProduitTotaux>,
    pub sites_actifs: Vec<String>,
}

/// Agrège les lignes mensuelles (total et par site) sur la fenêtre `months`,
/// avec report du stock de fin de mois sur les mois sans mouvement.
pub fn assembler_mensuel(months: &[String], mensuel_rows: &[PgMensuelRow]) -> Mensuel {
    let allowed: HashSet<&str> = months.iter().map(|m| m.as_str()).collect();

    let mut mensuel_total: SerieMensuelle = months.iter().map(|m| (m.clone(), empty_mois(m))).collect();
    let mut mensuel_par_site: BTreeMap<String, SerieMensuelle> = BTreeMap::new();

    // Mois réellement présents dans les mouvements. Indispensable pour distinguer
    // « pas de mouvement ce mois-là » (→ report du stock précédent) de « stock
    // effectivement nul » — c'est la convention de la Grille.
    let mut mois_avec_donnees: HashSet<String> = HashSet::new();
    let mut mois_avec_donnees_par_site: HashMap<String, HashSet<String>> = HashMap::new();

    for row in mensuel_rows {
        // SQL renvoie "YYYY-MM", la timeline de l'app utilise "YYYYMM".
        let mois = row.mois.replacen('-', "", 1);
        if !allowed.contains(mois.as_str()) {
            continue;
        }
        let site = js_trim(&row.site).to_string();

        let qte = ou_zero(row.qte_vendue);
        let ca = ou_zero(row.ca_ht);
        let marge = ou_zero(row.marge);
        let stock_fin_mois = ou_zero(row.stock_fin_mois.unwrap_or(0.0));
        let qte_recue = ou_zero(row.qte_recue);

        mois_avec_donnees.insert(mois.clone());
        if let Some(tot) = mensuel_total.get_mut(&mois) {
            tot.qte += qte;
            tot.ca += ca;
            tot.marge += marge;
            tot.stock_fin_mois += stock_fin_mois;
            tot.qte_recue += qte_recue;
        }

        let par_site =
            mensuel_par_site.entry(site.clone()).or_insert_with(|| months.iter().map(|m| (m.clone(), empty_mois(m))).collect());
        mois_avec_donnees_par_site.entry(site).or_default().insert(mois.clone());
        if let Some(cell) = par_site.get_mut(&mois) {
            cell.qte += qte;
            cell.ca += ca;
            cell.marge += marge;
            // Le SQL donne déjà le stock du dernier mouvement du mois pour ce site.
            cell.stock_fin_mois = stock_fin_mois;
            cell.qte_recue += qte_recue;
        }
    }

    // Report du stock de fin de mois sur les mois SANS mouvement (carry-forward),
    // même convention que la Grille : un mois sans mouvement conserve le stock du
    // mois précédent, alors qu'un mois avec mouvements et un stock nul reste à 0.
    let carry_forward = |serie: &mut SerieMensuelle, avec_donnees: Option<&HashSet<String>>| {
        let mut last = 0.0;
        for m in months {
            let Some(cell) = serie.get_mut(m) else { continue };
            if avec_donnees.is_some_and(|s| s.contains(m)) {
                last = cell.stock_fin_mois;
            } else {
                cell.stock_fin_mois = last;
            }
        }
    };
    carry_forward(&mut mensuel_total, Some(&mois_avec_donnees));
    for (site, by_site) in mensuel_par_site.iter_mut() {
        carry_forward(by_site, mois_avec_donnees_par_site.get(site));
    }

    let totaux = totaux_serie(months, &mensuel_total);
    let totaux_par_site: BTreeMap<String, ProduitTotaux> =
        mensuel_par_site.iter().map(|(site, by_site)| (site.clone(), totaux_serie(months, by_site))).collect();

    let mut sites_actifs: Vec<String> = totaux_par_site.iter().filter(|(_, t)| t.qte > 0.0).map(|(s, _)| s.clone()).collect();
    sites_actifs.sort();

    Mensuel { mensuel_total, mensuel_par_site, totaux, totaux_par_site, sites_actifs }
}

/// Assemble la fiche d'un produit **à partir de son code centrale** : c'est la
/// clé du réseau Qlik, seule identité disponible pour un produit que le réseau
/// travaille mais que Nancy ne référence pas.
///
/// Si le catalogue Nancy connaît ce code centrale, on rattache toute la partie
/// locale (identité, fournisseurs, stock, gammes, 12 mois glissants de ventes).
/// Sinon la fiche reste purement réseau, ce qui est un cas parfaitement normal
/// depuis la recherche Qlik.
///
/// Renvoie `None` uniquement si ni Qlik ni le catalogue ne connaissent le code.
pub async fn get_produit_fiche_by_code_centrale(code_centrale: &str) -> anyhow::Result<Option<ProduitFiche>> {
    let cleaned = js_trim(code_centrale);
    if cleaned.is_empty() {
        return Ok(None);
    }

    if let Some(codein) = pg_get_codein_by_code_centrale(cleaned).await {
        return get_produit_fiche(&codein).await;
    }

    // Produit réseau pur : aucune donnée locale à assembler.
    let mut map = get_network_metrics_by_code_centrale(&[cleaned.to_string()]).await?;
    let Some(reseau) = map.remove(cleaned) else {
        return Ok(None);
    };

    let periode = build_last12_months_range();
    let months = build_month_keys();
    let mensuel_total: SerieMensuelle = months.iter().map(|m| (m.clone(), empty_mois(m))).collect();
    let totaux = totaux_serie(&months, &mensuel_total);

    Ok(Some(ProduitFiche {
        detail: None,
        code_centrale: cleaned.to_string(),
        libelle_reseau: reseau.libelle_reseau.clone().unwrap_or_default(),
        fournisseur_reseau: reseau.fournisseur_reseau.clone().unwrap_or_default(),
        fournisseurs: vec![],
        stock: vec![],
        commandes_en_cours: 0.0,
        gammes: vec![],
        months,
        mensuel_total,
        mensuel_par_site: BTreeMap::new(),
        totaux,
        totaux_par_site: BTreeMap::new(),
        sites_actifs: vec![],
        reseau: Some(reseau),
        periode,
    }))
}

/// Assemble la fiche complète d'un produit : identité, fournisseurs, stock,
/// gammes, 12 mois glissants de ventes (total et par magasin) et métriques
/// réseau Qlik.
///
/// Renvoie `None` si le codein est inconnu du catalogue FF.
pub async fn get_produit_fiche(codein: &str) -> anyhow::Result<Option<ProduitFiche>> {
    let cleaned = js_trim(codein);
    if cleaned.is_empty() {
        return Ok(None);
    }

    let periode = build_last12_months_range();

    // Tout part en même temps : l'identité du produit était lue seule d'abord,
    // puis les cinq autres lectures, puis les métriques réseau — trois attentes
    // successives. Les métriques réseau n'attendent que l'identité (code centrale).
    let detail_et_reseau = async {
        let detail = pg_get_produit_detail(cleaned).await;
        let code = detail.as_ref().map(|d| d.code_centrale.clone()).filter(|c| !c.is_empty());
        let reseau = match code {
            Some(code) => get_network_metrics_by_code_centrale(std::slice::from_ref(&code)).await?.remove(&code),
            None => None,
        };
        anyhow::Ok((detail, reseau))
    };
    let (detail_et_reseau, fournisseurs, stock, commandes_en_cours, gammes, mensuel_rows) = tokio::join!(
        detail_et_reseau,
        pg_get_fournisseurs_by_codein(cleaned),
        pg_get_stock_by_codein(cleaned),
        pg_get_commandes_by_codein(cleaned),
        pg_get_gamme_history_by_codein(cleaned),
        pg_get_mensuel_by_codein(cleaned, &periode.date_debut, &periode.date_fin),
    );
    let (detail, reseau) = detail_et_reseau?;
    let Some(detail) = detail else {
        return Ok(None);
    };

    let months = build_month_keys();
    let Mensuel { mensuel_total, mensuel_par_site, totaux, totaux_par_site, sites_actifs } = assembler_mensuel(&months, &mensuel_rows);

    Ok(Some(ProduitFiche {
        code_centrale: detail.code_centrale.clone(),
        detail: Some(detail),
        libelle_reseau: reseau.as_ref().and_then(|r| r.libelle_reseau.clone()).unwrap_or_default(),
        fournisseur_reseau: reseau.as_ref().and_then(|r| r.fournisseur_reseau.clone()).unwrap_or_default(),
        fournisseurs,
        stock,
        commandes_en_cours,
        gammes,
        months,
        mensuel_total,
        mensuel_par_site,
        totaux,
        totaux_par_site,
        sites_actifs,
        reseau,
        periode,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ligne(site: &str, mois: &str, qte: f64, ca: f64, marge: f64, stock: Option<f64>, recu: f64) -> PgMensuelRow {
        PgMensuelRow {
            codein: "123".into(),
            site: site.into(),
            mois: mois.into(),
            qte_vendue: qte,
            ca_ht: ca,
            marge,
            stock_fin_mois: stock,
            qte_recue: recu,
        }
    }

    fn mois() -> Vec<String> {
        get_last12_months(chrono::NaiveDate::from_ymd_opt(2026, 3, 15).unwrap())
    }

    #[test]
    fn fenetre_12_mois_hors_mois_courant() {
        let m = mois();
        assert_eq!(m.len(), 12);
        assert_eq!(m.first().unwrap(), "202503");
        assert_eq!(m.last().unwrap(), "202602");
    }

    #[test]
    fn agrege_total_et_sites_avec_report_de_stock() {
        let m = mois();
        let rows = vec![
            ligne("292", "2025-04", 2.0, 20.0, 5.0, Some(10.0), 0.0),
            ligne(" 579 ", "2025-04", 1.0, 10.0, 2.0, Some(4.0), 3.0),
            // Mois avec mouvements et stock nul : reste à 0 (pas de report).
            ligne("292", "2025-06", 0.0, 0.0, 0.0, Some(0.0), 0.0),
            // Hors fenêtre : ignoré.
            ligne("292", "2024-01", 99.0, 99.0, 99.0, Some(99.0), 99.0),
        ];
        let r = assembler_mensuel(&m, &rows);

        assert_eq!(r.mensuel_total.len(), 12);
        let avril = &r.mensuel_total["202504"];
        assert_eq!((avril.qte, avril.ca, avril.marge, avril.stock_fin_mois, avril.qte_recue), (3.0, 30.0, 7.0, 14.0, 3.0));
        // Mars : avant tout mouvement → 0 ; mai : report d'avril ; juin : 0 réel ; juillet : report de juin.
        assert_eq!(r.mensuel_total["202503"].stock_fin_mois, 0.0);
        assert_eq!(r.mensuel_total["202505"].stock_fin_mois, 14.0);
        assert_eq!(r.mensuel_total["202506"].stock_fin_mois, 0.0);
        assert_eq!(r.mensuel_total["202602"].stock_fin_mois, 0.0);

        // Le site est « trimé » ; chaque site a ses 12 mois.
        assert_eq!(r.mensuel_par_site.keys().cloned().collect::<Vec<_>>(), vec!["292", "579"]);
        assert_eq!(r.mensuel_par_site["579"].len(), 12);
        assert_eq!(r.mensuel_par_site["579"]["202602"].stock_fin_mois, 4.0);
        assert_eq!(r.mensuel_par_site["292"]["202505"].stock_fin_mois, 10.0);
        assert_eq!(r.mensuel_par_site["292"]["202507"].stock_fin_mois, 0.0);

        assert_eq!(r.totaux, ProduitTotaux { qte: 3.0, ca: 30.0, marge: 7.0, taux_marge: 7.0 / 30.0 * 100.0 });
        assert_eq!(r.totaux_par_site["292"].qte, 2.0);
        assert_eq!(r.sites_actifs, vec!["292", "579"]);
    }

    #[test]
    fn site_sans_vente_non_actif_et_taux_nul_sans_ca() {
        let m = mois();
        let rows = vec![ligne("579", "2025-05", 0.0, 0.0, 0.0, None, 6.0)];
        let r = assembler_mensuel(&m, &rows);
        assert!(r.sites_actifs.is_empty());
        assert_eq!(r.totaux.taux_marge, 0.0);
        assert_eq!(r.mensuel_total["202505"].qte_recue, 6.0);
        assert_eq!(r.mensuel_total["202505"].stock_fin_mois, 0.0);
    }

    #[test]
    fn mois_vide_serialise_comme_le_ts() {
        let v = serde_json::to_value(empty_mois("202501")).unwrap();
        assert_eq!(v, serde_json::json!({ "mois": "202501", "qte": 0, "ca": 0, "marge": 0, "stockFinMois": 0, "qteRecue": 0 }));
    }
}
