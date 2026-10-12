//! CollectFlow — Helpers de fenêtre mensuelle (port des fonctions de
//! `src/features/grid/lib/months.ts` utilisées côté serveur).
//!
//! ⚠️ Deux conventions de clé de mois cohabitent dans l'application :
//!   - séries FF Nancy (ventes / stock / réceptions) : `"YYYYMM"` (sans tiret)
//!   - séries réseau Qlik (`qteByMonth`, `metricsByMonth`)  : `"YYYY-MM"` (avec tiret)
//!
//! Utiliser [`ff_month_to_qlik`] / [`qlik_month_to_ff`] pour passer de l'une à l'autre.

use super::types::ProductRow;
use chrono::{Datelike, NaiveDate};

/// Date du jour, heure locale du serveur (`new Date()`).
pub fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// Les 12 mois complets glissants, du plus ancien au plus récent, au format
/// `"YYYYMM"`. Le mois en cours est **exclu** (on part de i=12 jusqu'à i=1).
///
/// Même fenêtre que `last12Periods()` dans `get-product-rows.ts`.
pub fn get_last12_months(now: NaiveDate) -> Vec<String> {
    (1..=12)
        .rev()
        .map(|i: i32| {
            let total = now.year() * 12 + now.month0() as i32 - i;
            format!("{}{:02}", total.div_euclid(12), total.rem_euclid(12) + 1)
        })
        .collect()
}

/// Fenêtre de 12 mois **telle que le serveur l'a calculée**, lue dans les clés des
/// séries mensuelles des lignes reçues. `None` si aucune ligne ne porte de série
/// complète (l'appelant retombe alors sur [`get_last12_months`]).
pub fn get_months_from_rows(rows: &[ProductRow]) -> Option<Vec<String>> {
    for r in rows {
        let mut keys: Vec<&String> = r.sales12m.keys().filter(|k| k.len() == 6 && k.bytes().all(|b| b.is_ascii_digit())).collect();
        if keys.len() < 12 {
            continue;
        }
        // Toutes les lignes d'un même calcul partagent la même fenêtre : la
        // première ligne complète suffit.
        keys.sort();
        return Some(keys[keys.len() - 12..].iter().map(|k| k.to_string()).collect());
    }
    None
}

/// `"202601"` → `"Jan 26"`.
pub fn format_month_label(key: &str) -> String {
    const NOMS: [&str; 12] = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
    let m: usize = key.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0);
    let nom = m.checked_sub(1).and_then(|i| NOMS.get(i)).copied().unwrap_or("undefined");
    format!("{nom} {}", key.get(2..4).unwrap_or(""))
}

/// Clé de mois FF `"202601"` → clé Qlik `"2026-01"`.
pub fn ff_month_to_qlik(key: &str) -> String {
    format!("{}-{}", key.get(..4).unwrap_or(key), key.get(4..6).unwrap_or(""))
}

/// Clé de mois Qlik `"2026-01"` → clé FF `"202601"`.
pub fn qlik_month_to_ff(key: &str) -> String {
    key.replacen('-', "", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn douze_mois_hors_mois_en_cours() {
        let m = get_last12_months(NaiveDate::from_ymd_opt(2026, 1, 31).unwrap());
        assert_eq!(m.first().unwrap(), "202501");
        assert_eq!(m.last().unwrap(), "202512");
        assert_eq!(m.len(), 12);
    }

    #[test]
    fn conversions_de_cles() {
        assert_eq!(ff_month_to_qlik("202601"), "2026-01");
        assert_eq!(qlik_month_to_ff("2026-01"), "202601");
        assert_eq!(format_month_label("202602"), "Fév 26");
    }

    #[test]
    fn fenetre_depuis_les_lignes() {
        let mut r = ProductRow::default();
        for k in get_last12_months(NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()) {
            r.sales12m.insert(k, 1.0);
        }
        r.sales12m.insert("202409".into(), 0.0);
        let m = get_months_from_rows(&[ProductRow::default(), r]).unwrap();
        assert_eq!(m.first().unwrap(), "202510");
        assert_eq!(m.last().unwrap(), "202609");
    }
}
