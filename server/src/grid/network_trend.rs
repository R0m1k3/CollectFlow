//! CollectFlow — Tendance des ventes réseau Qlik sur 12 mois
//! (port de `src/features/grid/lib/network-trend.ts`).
//!
//! Partagé entre la Grille, la fiche produit et l'API `/api/v1` (champ `trend`).
//! Aucun changement de comportement.

use super::js;
use chrono::{Datelike, NaiveDate};
use serde::Serialize;
use std::collections::BTreeMap;

/// Nombre de magasins du réseau La Foir'Fouille servant de dénominateur au taux
/// de présence. Constante métier : source unique pour la Grille et la fiche produit.
pub const NB_MAGASINS_RESEAU: f64 = 270.0;

/// Nombre de mois comparés à chaque bout de la fenêtre.
///
/// Quatre, et pas un : comparer le dernier mois au premier ferait dépendre toute
/// la tendance de deux points, donc du hasard d'un réassort ou d'une opération.
pub const TREND_WINDOW: usize = 4;

/// Seuil de "forte" variation (±25%) pour distinguer hausse/forte hausse dans l'UI.
pub const TREND_STRONG: f64 = 0.25;

/// Seuil au-delà duquel on ne considère plus la tendance comme stable (±8%).
pub const TREND_FLAT: f64 = 0.08;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
    Flat,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Up => "up",
            Direction::Down => "down",
            Direction::Flat => "flat",
        }
    }
}

/// Couleur de chaque direction (`TREND_COLOR`).
pub fn trend_color(d: Direction) -> &'static str {
    match d {
        Direction::Up => "#22c55e",
        Direction::Down => "#ef4444",
        Direction::Flat => "#94a3b8",
    }
}

struct Nums<'a>(&'a [f64]);
impl Serialize for Nums<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(|v| js::JsNum(*v)))
    }
}

fn ser_nums<S: serde::Serializer>(v: &[f64], s: S) -> Result<S::Ok, S::Error> {
    Nums(v).serialize(s)
}
fn ser_opt_nums<S: serde::Serializer>(v: &Option<Vec<f64>>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(v) => Nums(v).serialize(s),
        None => s.serialize_none(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkTrend {
    /// quantités mensuelles, ordre chronologique
    #[serde(serialize_with = "ser_nums")]
    pub values: Vec<f64>,
    /// "YYYY-MM"
    pub labels: Vec<String>,
    /// Quantité moyenne par magasin vendeur, mois par mois. `None` si le nombre
    /// de magasins n'est pas connu sur les 12 mois.
    #[serde(serialize_with = "ser_opt_nums")]
    pub per_store: Option<Vec<f64>>,
    /// `true` si la tendance porte sur la qté/magasin, `false` si elle a dû se
    /// rabattre sur les quantités brutes faute de nombre de magasins.
    pub sur_qte_par_magasin: bool,
    pub direction: Direction,
    /// Variation des 4 derniers mois vs les 4 premiers. `None` si aucune base.
    #[serde(serialize_with = "js::opt_num::serialize")]
    pub pct: Option<f64>,
    /// Rien sur les 4 premiers mois, des ventes sur les 4 derniers.
    pub nouveau: bool,
    /// `true` si la fenêtre s'arrête un mois plus tôt que prévu : le cache Qlik
    /// n'a pas encore été resynchronisé depuis le changement de mois.
    pub en_retard: bool,
    pub has_data: bool,
}

/// Premier jour du mois décalé de `delta` mois (`new Date(y, m + delta, 1)`).
fn mois_decale(now: NaiveDate, delta: i32) -> (i32, u32) {
    let total = now.year() * 12 + now.month0() as i32 + delta;
    (total.div_euclid(12), total.rem_euclid(12) as u32 + 1)
}

/// Les 12 mois complets glissants au format Qlik `"YYYY-MM"`, du plus ancien au
/// plus récent. **Le mois en cours est exclu** : il est partiel, l'intégrer
/// écraserait systématiquement la tendance vers le bas.
///
/// Même fenêtre que `getLast12Months()` (clés FF `"YYYYMM"`) et que
/// `buildGridNetworkQlikDateFilter()` (extraction Qlik) — les trois doivent
/// rester alignés.
pub fn build_rolling12_qlik_months(now: NaiveDate) -> Vec<String> {
    (1..=12)
        .rev()
        .map(|i| {
            let (y, m) = mois_decale(now, -i);
            format!("{y}-{m:02}")
        })
        .collect()
}

/// Les 12 clés de la fenêtre sont-elles explicitement présentes et chiffrées ?
fn fenetre_complete(serie: &BTreeMap<String, f64>, labels: &[String]) -> bool {
    labels.iter().all(|l| serie.get(l).map(|v| v.is_finite()).unwrap_or(false))
}

/// Les 12 mois réellement disponibles dans une série Qlik : la fenêtre du jour,
/// sinon celle qui s'arrête un mois plus tôt.
///
/// Le repli couvre les jours qui suivent un changement de mois : la fenêtre a
/// glissé, mais le cache Qlik n'est resynchronisé que fournisseur par
/// fournisseur, la nuit. Sans lui, toutes les tendances disparaissaient d'un
/// coup le 1er du mois. Ce sont toujours 12 mois complets et extraits — aucun
/// mois n'est inventé — simplement décalés d'un cran. `None` si aucune des deux
/// fenêtres n'est complète.
pub fn fenetre_disponible(serie: Option<&BTreeMap<String, f64>>, now: NaiveDate) -> Option<(Vec<String>, bool)> {
    let serie = serie?;
    let labels = build_rolling12_qlik_months(now);
    if fenetre_complete(serie, &labels) {
        return Some((labels, false));
    }
    let (y, m) = mois_decale(now, -1);
    let precedente = build_rolling12_qlik_months(NaiveDate::from_ymd_opt(y, m, 1)?);
    if fenetre_complete(serie, &precedente) {
        return Some((precedente, true));
    }
    None
}

/// Tendance réseau : variation entre les **4 premiers** et les **4 derniers**
/// mois de la fenêtre de 12 mois glissants, mois en cours exclu.
///
/// Une série n'est retenue que si les **12 clés sont explicitement présentes**
/// (tout ou rien) ; la tendance porte sur la **quantité par magasin vendeur**
/// quand le nombre de magasins est connu sur les 12 mois, sinon sur les
/// quantités brutes (`surQteParMagasin = false`). Sans base de comparaison (rien
/// vendu sur les 4 premiers mois), aucun pourcentage n'est inventé : le produit
/// est signalé « nouveau ».
///
/// Direction : forte hausse >+25%, hausse >+8%, stable, baisse <−8%, forte baisse <−25%.
pub fn compute_network_trend(
    qte_by_month: Option<&BTreeMap<String, f64>>,
    nb_mag_by_month: Option<&BTreeMap<String, f64>>,
    now: NaiveDate,
) -> NetworkTrend {
    let empty = NetworkTrend {
        values: vec![],
        labels: vec![],
        per_store: None,
        sur_qte_par_magasin: false,
        direction: Direction::Flat,
        pct: None,
        nouveau: false,
        en_retard: false,
        has_data: false,
    };
    let (Some(qte), Some((labels, en_retard))) = (qte_by_month, fenetre_disponible(qte_by_month, now)) else {
        return empty;
    };

    let values: Vec<f64> = labels.iter().map(|l| qte.get(l).copied().unwrap_or(f64::NAN)).collect();
    let n = values.len();

    // Quantité par magasin vendeur : l'indicateur qui isole la performance du
    // produit de sa diffusion. Un mois sans magasin vendeur vaut 0 — c'est le
    // seul choix cohérent avec une quantité elle-même nulle.
    let magasins = compute_stores_series(nb_mag_by_month, Some(&labels));
    let per_store: Option<Vec<f64>> =
        magasins.map(|(mags, _)| values.iter().zip(mags.iter()).map(|(v, m)| if *m > 0.0 { v / m } else { 0.0 }).collect());
    let serie: &[f64] = per_store.as_deref().unwrap_or(&values);

    let taille = TREND_WINDOW.min(n / 2);
    let moyenne = |xs: &[f64]| if xs.is_empty() { 0.0 } else { xs.iter().sum::<f64>() / xs.len() as f64 };
    let debut = moyenne(&serie[..taille]);
    let fin = moyenne(&serie[n - taille..]);

    let mut pct = None;
    let mut nouveau = false;
    let mut direction = Direction::Flat;

    if debut > 0.0 {
        // Plancher naturel à −100 % : `fin` ne peut pas descendre sous zéro sans
        // retours massifs, et la division par une base positive garde le sens.
        let p = (fin - debut) / debut;
        direction = if p > TREND_FLAT {
            Direction::Up
        } else if p < -TREND_FLAT {
            Direction::Down
        } else {
            Direction::Flat
        };
        pct = Some(p);
    } else if fin > 0.0 {
        // Rien au départ, des ventes à l'arrivée : la variation relative n'existe
        // pas (division par zéro). On le dit, au lieu d'afficher un nombre inventé.
        nouveau = true;
        direction = Direction::Up;
    }

    let sur_qte_par_magasin = per_store.is_some();
    NetworkTrend { values, labels, per_store, sur_qte_par_magasin, direction, pct, nouveau, en_retard, has_data: true }
}

/// Série « nombre de magasins vendeurs » sur la MÊME fenêtre que
/// [`compute_network_trend`], pour la superposer à la courbe des quantités.
///
/// Même règle du tout ou rien que la courbe des quantités : les 12 clés doivent
/// être explicitement présentes, sinon `None` — un mois non extrait ne doit pas
/// se lire comme « zéro magasin », ce qui simulerait un arrêt de diffusion.
/// Renvoie `(values, labels)`.
pub fn compute_stores_series(
    nb_mag_by_month: Option<&BTreeMap<String, f64>>,
    labels: Option<&[String]>,
) -> Option<(Vec<f64>, Vec<String>)> {
    let serie = nb_mag_by_month?;
    let labels = labels.filter(|l| !l.is_empty())?;
    if !fenetre_complete(serie, labels) {
        return None;
    }
    Some((labels.iter().map(|l| serie[l]).collect(), labels.to_vec()))
}

/// Libellé français de la tendance : « Forte hausse », « Baisse », « Stable »…
pub fn trend_label(pct: Option<f64>, nouveau: bool) -> &'static str {
    // Un produit sans base de comparaison n'est pas « stable » : il est nouveau.
    if nouveau {
        return "Nouveau";
    }
    let Some(p) = pct else { return "Stable" };
    if p > TREND_STRONG {
        "Forte hausse"
    } else if p > TREND_FLAT {
        "Hausse"
    } else if p < -TREND_STRONG {
        "Forte baisse"
    } else if p < -TREND_FLAT {
        "Baisse"
    } else {
        "Stable"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, j: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, j).unwrap()
    }

    fn serie(labels: &[String], f: impl Fn(usize) -> f64) -> BTreeMap<String, f64> {
        labels.iter().enumerate().map(|(i, l)| (l.clone(), f(i))).collect()
    }

    #[test]
    fn fenetre_glissante_hors_mois_en_cours() {
        let m = build_rolling12_qlik_months(d(2026, 1, 15));
        assert_eq!(m.len(), 12);
        assert_eq!(m.first().unwrap(), "2025-01");
        assert_eq!(m.last().unwrap(), "2025-12");
        let m = build_rolling12_qlik_months(d(2026, 10, 1));
        assert_eq!(m.first().unwrap(), "2025-10");
        assert_eq!(m.last().unwrap(), "2026-09");
    }

    #[test]
    fn tendance_hausse_par_magasin() {
        let now = d(2026, 10, 12);
        let labels = build_rolling12_qlik_months(now);
        let qte = serie(&labels, |i| {
            if i < 4 {
                10.0
            } else if i >= 8 {
                20.0
            } else {
                15.0
            }
        });
        let nb = serie(&labels, |_| 5.0);
        let t = compute_network_trend(Some(&qte), Some(&nb), now);
        assert!(t.has_data && t.sur_qte_par_magasin && !t.en_retard);
        assert_eq!(t.direction, Direction::Up);
        assert!((t.pct.unwrap() - 1.0).abs() < 1e-12);
        assert_eq!(trend_label(t.pct, t.nouveau), "Forte hausse");
        // Même quantité, mais diffusée dans deux fois plus de magasins : stable.
        let nb2 = serie(&labels, |i| {
            if i < 4 {
                5.0
            } else if i >= 8 {
                10.0
            } else {
                7.5
            }
        });
        let t2 = compute_network_trend(Some(&qte), Some(&nb2), now);
        assert_eq!(t2.direction, Direction::Flat);
        assert_eq!(trend_label(t2.pct, t2.nouveau), "Stable");
    }

    #[test]
    fn tendance_nouveau_retard_et_incomplet() {
        let now = d(2026, 10, 2);
        // Cache pas encore resynchronisé : fenêtre d'un mois plus tôt.
        let anciens = build_rolling12_qlik_months(d(2026, 9, 1));
        let qte = serie(&anciens, |i| if i < 4 { 0.0 } else { 3.0 });
        let t = compute_network_trend(Some(&qte), None, now);
        assert!(t.has_data && t.en_retard && t.nouveau && !t.sur_qte_par_magasin);
        assert_eq!(t.pct, None);
        assert_eq!(t.direction, Direction::Up);
        assert_eq!(trend_label(t.pct, t.nouveau), "Nouveau");
        // Un mois manquant : aucune tendance.
        let mut trou = qte.clone();
        trou.remove(&anciens[5]);
        let t = compute_network_trend(Some(&trou), None, now);
        assert!(!t.has_data);
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"values":[],"labels":[],"perStore":null,"surQteParMagasin":false,"direction":"flat","pct":null,"nouveau":false,"enRetard":false,"hasData":false}"#
        );
    }

    #[test]
    fn libelles() {
        assert_eq!(trend_label(None, false), "Stable");
        assert_eq!(trend_label(Some(0.1), false), "Hausse");
        assert_eq!(trend_label(Some(-0.1), false), "Baisse");
        assert_eq!(trend_label(Some(-0.3), false), "Forte baisse");
        assert_eq!(trend_label(Some(0.08), false), "Stable");
    }
}
