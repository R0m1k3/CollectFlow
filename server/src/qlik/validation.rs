//! Contrôles de plausibilité d'une extraction réseau Qlik
//! (port de `src/lib/qlik-validation.ts`).
//!
//! L'extracteur vérifie déjà que les 12 mois de la fenêtre sont servis. Il ne
//! peut pas voir deux pièges, observés ou attendus en production, qui donnent
//! des chiffres faux mais complets :
//!
//!  1. **Dernier mois pas encore chargé dans Qlik.** Les premiers jours du mois,
//!     le mois qui vient de se terminer peut n'être chargé qu'en partie. Il est
//!     « couvert » (quelques ventes), donc accepté — et toutes les tendances du
//!     fournisseur plongent d'un coup, jusqu'à la synchro suivante, une semaine
//!     ou plus après.
//!  2. **Mesure insensible au mois.** Quand une mesure ignore la sélection de
//!     dates, chaque mois reçoit la même valeur (le total de l'année). Le
//!     diagnostic existait dans les journaux ; rien n'empêchait l'écriture.
//!
//! Dans les deux cas, garder le cache précédent vaut mieux qu'écrire des
//! données fausses : l'extraction est refusée, et le planificateur la reprend
//! une nuit suivante.
//!
//! Module pur : testé par `cargo test`.

use super::client::{NetworkMetric, QlikMonthMetrics};
use super::jsnum::texte;
use chrono::{Datelike, NaiveDate};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ControleExtraction {
    pub ok: bool,
    /// Raison du refus, lisible par l'administrateur (statut de synchro).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motif: Option<String>,
    /// Anomalies corrigées ou tolérées, à journaliser.
    pub avertissements: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct OptionsControle {
    /// Jusqu'à quel jour du mois le dernier mois est soupçonné d'être incomplet.
    /// Au-delà, une baisse est prise pour ce qu'elle est : une baisse.
    pub jour_limite_dernier_mois: u32,
    /// Part minimale du dernier mois par rapport à la moyenne des 3 précédents.
    pub ratio_dernier_mois_min: f64,
    /// Volume mensuel moyen en dessous duquel le contrôle n'a pas de sens.
    pub volume_minimal: f64,
    /// Part maximale de séries plates (même valeur 12 mois) parmi les séries vendues.
    pub part_series_plates_max: f64,
}

impl Default for OptionsControle {
    fn default() -> Self {
        Self { jour_limite_dernier_mois: 10, ratio_dernier_mois_min: 0.4, volume_minimal: 30.0, part_series_plates_max: 0.5 }
    }
}

fn fini(v: Option<f64>) -> f64 {
    match v {
        Some(n) if n.is_finite() => n,
        _ => 0.0,
    }
}

/// `Math.round` JS (demi vers +∞).
fn arrondi_js(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// Corrige sur place les valeurs impossibles d'une métrique (NaN, infini,
/// nombre de magasins négatif) et renvoie la liste des corrections.
pub fn assainir_metrique(m: &mut NetworkMetric) -> Vec<String> {
    let mut corrections = Vec::new();
    let code = m.code_centrale.clone();
    for (champ, valeur) in [
        ("caReseau", &mut m.ca_reseau),
        ("qteReseau", &mut m.qte_reseau),
        ("nbMagasinsReseau", &mut m.nb_magasins_reseau),
        ("caParMagasinReseau", &mut m.ca_par_magasin_reseau),
        ("margePctReseau", &mut m.marge_pct_reseau),
    ] {
        if !valeur.is_finite() {
            corrections.push(format!("{code} : {champ} non numérique ({}) remplacé par 0", texte(*valeur)));
            *valeur = 0.0;
        }
    }
    if m.nb_magasins_reseau < 0.0 {
        corrections.push(format!("{code} : nombre de magasins négatif ({}) remplacé par 0", texte(m.nb_magasins_reseau)));
        m.nb_magasins_reseau = 0.0;
    }
    m.nb_magasins_reseau = arrondi_js(m.nb_magasins_reseau);
    m.ca_par_magasin_reseau = if m.nb_magasins_reseau > 0.0 { m.ca_reseau / m.nb_magasins_reseau } else { 0.0 };

    if let Some(q) = m.qte_by_month.as_mut() {
        for (mois, v) in q.iter_mut() {
            if !v.is_finite() {
                corrections.push(format!("{code} : quantité {mois} non numérique remplacée par 0"));
                *v = 0.0;
            }
        }
    }
    if let Some(mm) = m.metrics_by_month.as_mut() {
        for v in mm.values_mut() {
            *v = QlikMonthMetrics {
                qte: fini(Some(v.qte)),
                ca: Some(fini(v.ca)),
                nb_mag: Some(arrondi_js(fini(v.nb_mag)).max(0.0)),
                ca_mag: Some(fini(v.ca_mag)),
                marge_pct: Some(fini(v.marge_pct)),
            };
        }
    }
    corrections
}

/// Contrôle d'ensemble d'une extraction 12 mois, AVANT écriture du cache.
///
/// `fenetre` : les mois attendus (« YYYY-MM »), du plus ancien au plus récent.
/// `now` : date locale du jour.
pub fn controler_extraction<'a>(
    metriques: impl IntoIterator<Item = &'a NetworkMetric>,
    fenetre: &[String],
    now: NaiveDate,
    o: OptionsControle,
) -> ControleExtraction {
    let mut avertissements = Vec::new();
    let liste: Vec<&NetworkMetric> = metriques.into_iter().collect();
    if liste.is_empty() || fenetre.len() < 4 {
        return ControleExtraction { ok: true, motif: None, avertissements };
    }
    let qte = |m: &NetworkMetric, mois: &str| fini(m.qte_by_month.as_ref().and_then(|q| q.get(mois).copied()));

    // ── 1. Séries plates : la mesure a ignoré la sélection de mois ──────────
    let mut vendues = 0usize;
    let mut plates = 0usize;
    for m in &liste {
        let valeurs: Vec<f64> = fenetre.iter().map(|mois| qte(m, mois)).collect();
        if !valeurs.iter().any(|v| *v != 0.0) {
            continue;
        }
        vendues += 1;
        if valeurs.iter().all(|v| *v == valeurs[0]) {
            plates += 1;
        }
    }
    if vendues >= 5 && plates as f64 / vendues as f64 > o.part_series_plates_max {
        return ControleExtraction {
            ok: false,
            motif: Some(format!("{plates} séries sur {vendues} ont la même quantité les 12 mois : la mesure Qlik ignore le mois, données refusées")),
            avertissements,
        };
    }
    if plates > 0 {
        avertissements.push(format!("{plates} série(s) identique(s) sur 12 mois parmi {vendues} vendues"));
    }

    // ── 2. Dernier mois manifestement incomplet ─────────────────────────────
    let totaux: Vec<f64> = fenetre.iter().map(|mois| liste.iter().map(|m| qte(m, mois)).sum()).collect();
    let dernier = totaux[totaux.len() - 1];
    let precedents = &totaux[totaux.len() - 4..totaux.len() - 1];
    let reference = precedents.iter().sum::<f64>() / precedents.len() as f64;
    if now.day() <= o.jour_limite_dernier_mois && reference >= o.volume_minimal && dernier < reference * o.ratio_dernier_mois_min {
        let pct = arrondi_js(dernier / reference * 100.0);
        return ControleExtraction {
            ok: false,
            motif: Some(format!(
                "le dernier mois ({}) ne pèse que {} % des 3 mois précédents : probablement pas encore entièrement chargé dans Qlik, données refusées (nouvel essai une prochaine nuit)",
                fenetre[fenetre.len() - 1],
                texte(pct)
            )),
            avertissements,
        };
    }

    ControleExtraction { ok: true, motif: None, avertissements }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn fenetre() -> Vec<String> {
        (1..=12).map(|m| format!("2025-{m:02}")).collect()
    }

    fn metrique(code: &str, qtes: &[f64]) -> NetworkMetric {
        let f = fenetre();
        NetworkMetric {
            code_centrale: code.into(),
            qte_by_month: Some(f.iter().cloned().zip(qtes.iter().copied()).collect::<BTreeMap<_, _>>()),
            ..Default::default()
        }
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn assainit_les_valeurs_impossibles() {
        let mut m = NetworkMetric {
            code_centrale: "C1".into(),
            ca_reseau: 100.0,
            qte_reseau: f64::NAN,
            nb_magasins_reseau: -3.0,
            marge_pct_reseau: f64::INFINITY,
            qte_by_month: Some(BTreeMap::from([("2025-01".into(), f64::NAN), ("2025-02".into(), 4.0)])),
            metrics_by_month: Some(BTreeMap::from([(
                "2025-01".into(),
                QlikMonthMetrics { qte: f64::NAN, ca: None, nb_mag: Some(2.5), ca_mag: Some(1.0), marge_pct: None },
            )])),
            ..Default::default()
        };
        let c = assainir_metrique(&mut m);
        assert_eq!(c.len(), 4, "{c:?}");
        assert!(c[0].contains("qteReseau non numérique (NaN)"));
        assert!(c[1].contains("margePctReseau non numérique (Infinity)"));
        assert!(c[2].contains("nombre de magasins négatif (-3)"));
        assert_eq!(m.qte_reseau, 0.0);
        assert_eq!(m.nb_magasins_reseau, 0.0);
        assert_eq!(m.ca_par_magasin_reseau, 0.0);
        assert_eq!(m.qte_by_month.as_ref().unwrap()["2025-01"], 0.0);
        let mm = &m.metrics_by_month.as_ref().unwrap()["2025-01"];
        assert_eq!(mm, &QlikMonthMetrics { qte: 0.0, ca: Some(0.0), nb_mag: Some(3.0), ca_mag: Some(1.0), marge_pct: Some(0.0) });

        let mut m2 = NetworkMetric { code_centrale: "C2".into(), ca_reseau: 90.0, nb_magasins_reseau: 2.6, ..Default::default() };
        assert!(assainir_metrique(&mut m2).is_empty());
        assert_eq!(m2.nb_magasins_reseau, 3.0);
        assert_eq!(m2.ca_par_magasin_reseau, 30.0);
    }

    #[test]
    fn refuse_les_series_plates() {
        let liste: Vec<NetworkMetric> = (0..6).map(|i| metrique(&format!("C{i}"), &[10.0; 12])).collect();
        let r = controler_extraction(&liste, &fenetre(), d("2026-01-20"), OptionsControle::default());
        assert!(!r.ok);
        assert!(r.motif.unwrap().starts_with("6 séries sur 6 ont la même quantité"));
    }

    #[test]
    fn tolere_quelques_series_plates() {
        let mut liste: Vec<NetworkMetric> =
            (0..5).map(|i| metrique(&format!("V{i}"), &[1., 2., 3., 4., 5., 6., 7., 8., 9., 10., 11., 12.])).collect();
        liste.push(metrique("P", &[5.0; 12]));
        let r = controler_extraction(&liste, &fenetre(), d("2026-01-20"), OptionsControle::default());
        assert!(r.ok);
        assert_eq!(r.avertissements, vec!["1 série(s) identique(s) sur 12 mois parmi 6 vendues".to_string()]);
    }

    #[test]
    fn refuse_un_dernier_mois_incomplet_en_debut_de_mois() {
        let mut q = [100.0; 12];
        q[11] = 20.0;
        q[0] = 99.0; // pas plate
        let liste = vec![metrique("C", &q)];
        let r = controler_extraction(&liste, &fenetre(), d("2026-01-05"), OptionsControle::default());
        assert!(!r.ok);
        assert!(r.motif.unwrap().starts_with("le dernier mois (2025-12) ne pèse que 20 % des 3 mois précédents"));
        // Après le 10 du mois : la baisse est réelle.
        assert!(controler_extraction(&liste, &fenetre(), d("2026-01-11"), OptionsControle::default()).ok);
        // Volume trop faible : pas de contrôle.
        let petit = vec![metrique("C", &[10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 11.0, 1.0])];
        assert!(controler_extraction(&petit, &fenetre(), d("2026-01-05"), OptionsControle::default()).ok);
    }

    #[test]
    fn fenetre_courte_ou_vide_acceptee() {
        assert!(controler_extraction(&[], &fenetre(), d("2026-01-05"), OptionsControle::default()).ok);
        let liste = vec![metrique("C", &[1.0; 12])];
        assert!(controler_extraction(&liste, &fenetre()[..3], d("2026-01-05"), OptionsControle::default()).ok);
    }
}
