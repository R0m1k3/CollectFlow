//! Helper de fenêtre temporelle pour Qlik réseau (port de `src/lib/qlik-date-range.ts`).
//!
//! Aligne la timeline d'extraction Qlik réseau sur la timeline de la grille :
//!   - `months_back` mois complets glissants (défaut : 12)
//!   - exclut systématiquement le mois courant
//!
//! Référence utilisée : `buildLast12MonthsRange()` de `api-ff-client.ts`
//! (même source que la grille). Si la source officielle change, mettre à jour
//! ici aussi.
//!
//! Qlik référence les dates par un sérial numérique (jours écoulés depuis
//! l'epoch Qlik 1899-12-30). Repères validés :
//!   2025-01-01 → 45658
//!   2025-06-19 → 45827
//!   2026-01-01 → 46023
//!   2026-06-19 → 46192
//!
//! Le filtre côté Qlik s'applique via une sélection de champ `Date` :
//!   - valeurs numériques = serials Qlik
//!   - la sélection par défaut (`{<Date={...}>}`) est héritée par toutes
//!     les master measures qui référencent le champ `Date`.
//!
//! Pourquoi `SelectValues` sur le champ plutôt que set analysis dans `qDef` ?
//!   - les master items sont référencés par `qLibraryId` (réutilisation sans
//!     devoir dupliquer l'expression)
//!   - `qLibraryId` + `qDef` ensemble n'est pas supporté par le moteur QIX
//!   - sélectionner toutes les dates de la fenêtre via `SelectValues` revient
//!     fonctionnellement à `{<Date={">=…<=…"}>}` pour les mesures qui touchent
//!     ce champ, sans dépendre de l'expression interne des master items
//!
//! Pas de secrets ici. Fonctions pures, testées par `cargo test`.

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

/// Bornes acceptées pour `months_back`. On reste sur 1..12 pour ne pas casser
/// la sémantique "12 mois glissants alignés sur la grille" : une valeur plus
/// grande n'apporterait pas de signal réseau supplémentaire (la grille
/// n'expose elle-même que ~12 mois). En-deçà de 1 mois, la fenêtre serait
/// vide (mois courant exclu) ou incohérente.
pub const QLIK_MONTHS_BACK_MIN: i64 = 1;
pub const QLIK_MONTHS_BACK_MAX: i64 = 12;
pub const QLIK_MONTHS_BACK_DEFAULT: i64 = 12;

/// Conversion d'une chaîne en nombre avec la sémantique de `Number(s)` en JS :
/// espaces ignorés, chaîne vide → 0, préfixes `0x` / `0o` / `0b`, sinon NaN.
pub fn js_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    let lower = s.to_ascii_lowercase();
    for (prefixe, base) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(reste) = lower.strip_prefix(prefixe) {
            return u64::from_str_radix(reste, base).map(|v| v as f64).unwrap_or(f64::NAN);
        }
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust accepte « inf », « nan »… que JS refuse : on les écarte.
    if lower.contains("inf") || lower.contains("nan") {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// Lit la variable d'environnement `name` et renvoie un entier borné entre
/// [`QLIK_MONTHS_BACK_MIN`] et [`QLIK_MONTHS_BACK_MAX`]. Renvoie `default_value`
/// si la variable est absente / vide / non numérique.
pub fn env_months_back(name: &str, default_value: i64) -> i64 {
    months_back_from(std::env::var(name).ok().as_deref(), default_value)
}

/// Cœur testable de [`env_months_back`].
pub fn months_back_from(raw: Option<&str>, default_value: i64) -> i64 {
    let Some(raw) = raw else { return default_value };
    if raw.trim().is_empty() {
        return default_value;
    }
    let parsed = js_number(raw);
    if !parsed.is_finite() {
        return default_value;
    }
    (parsed.trunc() as i64).clamp(QLIK_MONTHS_BACK_MIN, QLIK_MONTHS_BACK_MAX)
}

/// Epoch Qlik = 1899-12-30 (équivalent Excel/Lotus 1-2-3).
fn qlik_epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(1899, 12, 30).expect("epoch Qlik")
}

/// Repères de validation.
pub const QLIK_DATE_ANCHORS: [(&str, i64); 4] = [("2025-01-01", 45658), ("2025-06-19", 45827), ("2026-01-01", 46023), ("2026-06-19", 46192)];

fn parse_iso(iso_date: &str) -> Option<(i32, u32, u32)> {
    let b = iso_date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let chiffres = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = &iso_date[r];
        if part.bytes().all(|c| c.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    Some((chiffres(0..4)? as i32, chiffres(5..7)?, chiffres(8..10)?))
}

/// Jours depuis l'epoch Qlik pour une date (y, m, d), avec le débordement de
/// `Date.UTC` (mois 13 → janvier suivant, jour 32 → mois suivant…).
fn serial_ymd(y: i32, mo: u32, d: u32) -> i64 {
    let base = NaiveDate::from_ymd_opt(y, 1, 1).expect("année valide");
    let premier_du_mois = base.checked_add_months(chrono::Months::new(mo.saturating_sub(1))).unwrap_or(base);
    let date = premier_du_mois + Duration::days(d as i64 - 1);
    // Date.UTC(y, -1, …) n'arrive pas ici : le format impose deux chiffres ≥ 00.
    let date = if mo == 0 { date - chrono::Months::new(1) } else { date };
    (date - qlik_epoch()).num_days()
}

/// Convertit une date ISO `YYYY-MM-DD` en sérial Qlik numérique.
/// Inverse documenté : Qlik epoch = 1899-12-30 (jour 0).
///
/// Erreur si l'entrée n'est pas au format `YYYY-MM-DD`.
pub fn iso_date_to_qlik_serial(iso_date: &str) -> anyhow::Result<i64> {
    let Some((y, mo, d)) = parse_iso(iso_date) else {
        anyhow::bail!("isoDateToQlikSerial: format attendu YYYY-MM-DD, reçu \"{iso_date}\"");
    };
    Ok(serial_ymd(y, mo, d))
}

/// Convertit un sérial Qlik en date ISO `YYYY-MM-DD` (utile pour tests/diagnostics).
pub fn qlik_serial_to_iso_date(serial: i64) -> String {
    (qlik_epoch() + Duration::days(serial)).format("%Y-%m-%d").to_string()
}

/// Sérial Qlik → entier `AAAAMMJJ` (format de `Date_Key` sur certains modèles).
pub fn qlik_serial_to_ymd(serial: i64) -> i64 {
    let d = qlik_epoch() + Duration::days(serial);
    d.year() as i64 * 10000 + d.month() as i64 * 100 + d.day() as i64
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlikDateFilter {
    /// Date ISO du 1er jour de la fenêtre (inclus).
    pub date_debut: String,
    /// Date ISO du dernier jour de la fenêtre (inclus).
    pub date_fin: String,
    /// Sérial Qlik du 1er jour (= `Date >= …`).
    pub q_start: i64,
    /// Sérial Qlik du dernier jour (= `Date <= …`).
    pub q_end: i64,
    /// Libellé humain `YYYY-MM_YYYY-MM` pour logs / cache.
    pub label: String,
    /// Liste exhaustive des serials journaliers `[qStart..qEnd]` pour SelectValues.
    pub daily_serials: Vec<i64>,
    /// Expression set analysis prête à intégrer dans un `qDef` de mesure.
    pub set_analysis: String,
}

/// Dernier jour du mois (m: 1..12).
fn last_day_of_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1).expect("mois valide").pred_opt().expect("veille").day()
}

/// Calcule la fenêtre `months_back` mois complets (excluant le mois courant).
///
/// `now` est la date LOCALE du jour (`chrono::Local::now().date_naive()`) : les
/// bornes sont des dates calendaires Qlik, jamais converties en UTC — minuit
/// local en Europe/Paris devenait la veille en UTC et transformait par exemple
/// 2025-07-01 en 2025-06-30, soit une extraction de 13 mois.
///
/// Bornes : `months_back` est ramené dans `[QLIK_MONTHS_BACK_MIN, QLIK_MONTHS_BACK_MAX]`
/// (1..12) sans erreur — on veut que la sync reste possible même si l'env est
/// mal configuré.
pub fn build_grid_network_qlik_date_filter(now: NaiveDate, months_back: i64) -> QlikDateFilter {
    let months = months_back.clamp(QLIK_MONTHS_BACK_MIN, QLIK_MONTHS_BACK_MAX) as u32;
    let premier_du_mois = NaiveDate::from_ymd_opt(now.year(), now.month(), 1).expect("date valide");
    // Fin : dernier jour du mois précédent le mois courant
    let end_month = premier_du_mois.pred_opt().expect("veille");
    // Début : `months` mois avant le mois courant (1er du mois)
    let start_month = premier_du_mois - chrono::Months::new(months);

    let date_debut = start_month.format("%Y-%m-%d").to_string();
    let date_fin = end_month.format("%Y-%m-%d").to_string();
    let q_start = (start_month - qlik_epoch()).num_days();
    let q_end = (end_month - qlik_epoch()).num_days();
    // qEnd < qStart est impossible ici (au moins un mois complet) : le TS levait
    // une exception pour ce cas, inatteignable avec des bornes ramenées à 1..12.
    let daily_serials: Vec<i64> = (q_start..=q_end).collect();
    let label = format!("{}_{}", &date_debut[..7], &date_fin[..7]);
    let set_analysis = format!("Date={{\">={q_start}<={q_end}\"}}");
    QlikDateFilter { date_debut, date_fin, q_start, q_end, label, daily_serials, set_analysis }
}

/// Fenêtre du jour (date locale) — `buildGridNetworkQlikDateFilter()` sans argument.
pub fn build_grid_network_qlik_date_filter_now(months_back: i64) -> QlikDateFilter {
    build_grid_network_qlik_date_filter(chrono::Local::now().date_naive(), months_back)
}

/// Découpe les serials en lots pour appels `SelectValues` paginés.
/// Par défaut 500 valeurs/appel (largement < limite Qlik ~10k par requête).
pub fn chunk_serials(serials: &[i64], batch_size: usize) -> Vec<Vec<i64>> {
    serials.chunks(batch_size.max(1)).map(|c| c.to_vec()).collect()
}

/// Découpe une fenêtre temporelle en sous-fenêtres mensuelles calendaires
/// **inclusives et continues**.
///
/// But : éviter qu'un seul hypercube Qlik ne doive charger 365 jours × N
/// codes d'un coup (provoque `code:15 Request aborted`). Avec cette découpe,
/// chaque mois ≈ 28–31 jours × N codes → beaucoup plus léger pour l'Engine.
///
/// Règles :
///  - Le 1er mois commence à `filter.date_debut` (peut être un jour quelconque).
///  - Chaque mois intermédiaire est un mois calendaire **complet**.
///  - Le dernier mois se termine à `filter.date_fin` (tronqué si pas fin de mois).
///  - Les mois sont contigus : fin d'un mois + 1 = début du suivant.
///  - Si début et fin tombent dans le même mois, on renvoie un seul mois.
///
/// Chaque mois retourné est un `QlikDateFilter` autonome (`label` au format `YYYY-MM`).
pub fn get_month_ranges(filter: &QlikDateFilter) -> Vec<QlikDateFilter> {
    let start = filter.date_debut.as_str();
    let end = filter.date_fin.as_str();
    let num = |s: &str, r: std::ops::Range<usize>| -> i64 { s.get(r).and_then(|x| x.parse().ok()).unwrap_or(0) };
    let sy = num(start, 0..4) as i32;
    let sm = num(start, 5..7) as u32;
    let ey = num(end, 0..4) as i32;
    let em = num(end, 5..7) as u32;
    let ed = num(end, 8..10) as u32;

    let mut out = Vec::new();
    let (mut cur_y, mut cur_m) = (sy, sm);
    // Sécurité anti-boucle infinie (au cas où) : 100 ans, large.
    const MAX_MONTHS: usize = 1200;
    let mut safety = 0;
    while safety < MAX_MONTHS && (1..=12).contains(&cur_m) {
        safety += 1;
        let is_first = cur_y == sy && cur_m == sm;
        let is_last = cur_y == ey && cur_m == em;

        // Début : si c'est le premier mois, on respecte `date_debut` ; sinon le 1er.
        let start_day = if is_first { num(start, 8..10) as u32 } else { 1 };
        let month_start = format!("{cur_y}-{cur_m:02}-{start_day:02}");
        // Fin : si c'est le dernier mois, on respecte `date_fin` ; sinon le dernier jour.
        let end_day = if is_last { ed } else { last_day_of_month(cur_y, cur_m) };
        let month_end = format!("{cur_y}-{cur_m:02}-{end_day:02}");

        let q_start = serial_ymd(cur_y, cur_m, start_day);
        let q_end = serial_ymd(cur_y, cur_m, end_day);
        let daily_serials: Vec<i64> = (q_start..=q_end).collect();
        out.push(QlikDateFilter {
            date_debut: month_start,
            date_fin: month_end,
            q_start,
            q_end,
            label: format!("{cur_y}-{cur_m:02}"),
            daily_serials,
            set_analysis: format!("Date={{\">={q_start}<={q_end}\"}}"),
        });
        if is_last {
            break;
        }
        // Avance d'un mois calendaire (gère le passage décembre → janvier).
        cur_m += 1;
        if cur_m > 12 {
            cur_m = 1;
            cur_y += 1;
        }
    }

    if out.is_empty() {
        // Fenêtre vide : on retourne un seul mois vide aligné sur date_debut.
        out.push(QlikDateFilter {
            date_debut: filter.date_debut.clone(),
            date_fin: filter.date_fin.clone(),
            q_start: filter.q_start,
            q_end: filter.q_end,
            label: start.get(0..7).unwrap_or(start).to_string(),
            daily_serials: Vec::new(),
            set_analysis: format!("Date={{\">={}<={}\"}}", filter.q_start, filter.q_end),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    // [1] + [2] Repères Qlik et aller-retour.
    #[test]
    fn reperes_qlik() {
        for (iso, serial) in QLIK_DATE_ANCHORS {
            assert_eq!(iso_date_to_qlik_serial(iso).unwrap(), serial, "{iso}");
            assert_eq!(qlik_serial_to_iso_date(serial), iso);
        }
    }

    // [3] Fenêtre grille (now=2026-06-21) → 2025-06-01 .. 2026-05-31
    #[test]
    fn fenetre_juin_2026() {
        let f = build_grid_network_qlik_date_filter(d("2026-06-21"), QLIK_MONTHS_BACK_DEFAULT);
        assert_eq!(f.date_debut, "2025-06-01");
        assert_eq!(f.date_fin, "2026-05-31");
        assert_eq!(f.q_start, 45809);
        assert_eq!(f.q_end, 46173);
        assert_eq!(f.label, "2025-06_2026-05");
        assert_eq!(f.set_analysis, r#"Date={">=45809<=46173"}"#);
        assert_eq!(f.daily_serials.len(), 365);
        assert_eq!(f.daily_serials[0], 45809);
        assert_eq!(f.daily_serials[364], 46173);
    }

    // [4] et [5]
    #[test]
    fn fenetres_mars_et_bissextile() {
        let f2 = build_grid_network_qlik_date_filter(d("2026-03-15"), 12);
        assert_eq!((f2.date_debut.as_str(), f2.date_fin.as_str()), ("2025-03-01", "2026-02-28"));
        assert_eq!((f2.q_start, f2.q_end), (45717, 46081));
        let f3 = build_grid_network_qlik_date_filter(d("2025-01-05"), 12);
        assert_eq!((f3.date_debut.as_str(), f3.date_fin.as_str()), ("2024-01-01", "2024-12-31"));
        assert_eq!(f3.daily_serials.len(), 366);
    }

    // [6] chunkSerials
    #[test]
    fn decoupe_serials() {
        let f = build_grid_network_qlik_date_filter(d("2026-06-21"), 12);
        let chunks = chunk_serials(&f.daily_serials, 100);
        assert_eq!(chunks.len(), 4);
        assert_eq!(chunks[3].len(), 65);
        assert_eq!(chunks[0][0], 45809);
        assert_eq!(chunks[3][64], 46173);
    }

    // [7] Robustesse
    #[test]
    fn formats_invalides() {
        for bad in ["2025/01/01", ""] {
            let e = iso_date_to_qlik_serial(bad).unwrap_err().to_string();
            assert!(e.contains("YYYY-MM-DD"), "{e}");
        }
        let f = build_grid_network_qlik_date_filter(d("2026-06-21"), 12);
        assert!(!f.label.is_empty());
        assert!(f.set_analysis.starts_with("Date="));
    }

    // [8] getMonthRanges — fenêtre 12 mois
    #[test]
    fn mois_de_la_fenetre() {
        let f = build_grid_network_qlik_date_filter(d("2026-06-21"), 12);
        let months = get_month_ranges(&f);
        assert_eq!(months.len(), 12);
        assert_eq!(months[0].label, "2025-06");
        assert_eq!(months[0].date_debut, "2025-06-01");
        assert_eq!(months[0].date_fin, "2025-06-30");
        assert_eq!(months[0].daily_serials.len(), 30);
        assert_eq!(months[0].q_start, 45809);
        assert_eq!(months[0].q_end, 45838);
        assert_eq!(months[11].label, "2026-05");
        assert_eq!(months[11].date_debut, "2026-05-01");
        assert_eq!(months[11].date_fin, "2026-05-31");
        assert_eq!(months[11].daily_serials.len(), 31);
        let feb25 = get_month_ranges(&build_grid_network_qlik_date_filter(d("2025-06-15"), 12));
        assert!(feb25.iter().any(|m| m.label == "2025-02" && m.daily_serials.len() == 28));
        let biss = get_month_ranges(&build_grid_network_qlik_date_filter(d("2025-01-05"), 12));
        assert!(biss.iter().any(|m| m.label == "2024-02" && m.daily_serials.len() == 29));
        assert_eq!(months.iter().map(|m| m.daily_serials.len()).sum::<usize>(), 365);
    }

    // [9] fenêtre courte partielle
    #[test]
    fn fenetre_partielle() {
        let mut f = build_grid_network_qlik_date_filter(d("2026-06-21"), 12);
        f.date_debut = "2025-06-01".into();
        f.date_fin = "2025-08-15".into();
        f.q_start = 45809;
        f.q_end = 45884;
        f.daily_serials.clear();
        f.set_analysis.clear();
        let m = get_month_ranges(&f);
        assert_eq!(m.len(), 3);
        assert_eq!(m[2].daily_serials.len(), 15);
        assert_eq!(m[2].date_fin, "2025-08-15");
    }

    // [10] monthsBack=6
    #[test]
    fn six_mois() {
        let f6 = build_grid_network_qlik_date_filter(d("2026-06-21"), 6);
        assert_eq!(f6.date_debut, "2025-12-01");
        assert_eq!(f6.date_fin, "2026-05-31");
        assert_eq!((f6.q_start, f6.q_end), (45992, 46173));
        assert_eq!(f6.label, "2025-12_2026-05");
        assert_eq!(f6.daily_serials.len(), 182);
        let m6 = get_month_ranges(&f6);
        assert_eq!(m6.len(), 6);
        assert_eq!(m6[0].label, "2025-12");
        assert_eq!(m6[5].label, "2026-05");
        assert_eq!(m6.iter().map(|m| m.daily_serials.len()).sum::<usize>(), 182);
    }

    // [11] bornes et clamp
    #[test]
    fn bornes_months_back() {
        let now = d("2026-06-21");
        let x = build_grid_network_qlik_date_filter(now, 1);
        assert_eq!((x.date_debut.as_str(), x.date_fin.as_str()), ("2026-05-01", "2026-05-31"));
        assert_eq!(build_grid_network_qlik_date_filter(now, 0).date_debut, "2026-05-01");
        let x = build_grid_network_qlik_date_filter(now, 24);
        assert_eq!((x.date_debut.as_str(), x.date_fin.as_str()), ("2025-06-01", "2026-05-31"));
        assert_eq!(build_grid_network_qlik_date_filter(now, -5).date_debut, "2026-05-01");
        assert_eq!((QLIK_MONTHS_BACK_MIN, QLIK_MONTHS_BACK_MAX, QLIK_MONTHS_BACK_DEFAULT), (1, 12, 12));
    }

    // [12] envMonthsBack — lecture env (cœur pur, sans toucher l'environnement du processus)
    #[test]
    fn lecture_env_months_back() {
        let def = QLIK_MONTHS_BACK_DEFAULT;
        assert_eq!(months_back_from(None, def), def);
        assert_eq!(months_back_from(Some(""), def), def);
        assert_eq!(months_back_from(Some("6"), def), 6);
        assert_eq!(months_back_from(Some("abc"), def), def);
        assert_eq!(months_back_from(Some("24"), def), QLIK_MONTHS_BACK_MAX);
        assert_eq!(months_back_from(Some("-3"), def), QLIK_MONTHS_BACK_MIN);
        assert_eq!(months_back_from(Some("0"), def), QLIK_MONTHS_BACK_MIN);
        assert_eq!(months_back_from(Some("3.7"), def), 3);
        assert_eq!(months_back_from(Some("  8  "), def), 8);
        assert_eq!(months_back_from(Some("NaN"), def), def);
        assert_eq!(months_back_from(Some("Infinity"), def), def);
        // Sur le vrai environnement : variable absente → défaut.
        assert_eq!(env_months_back("QLIK_TEST_MONTHS_BACK_ABSENTE_XYZ", def), def);
    }

    #[test]
    fn nombres_facon_js() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e2"), 100.0);
        assert!(js_number("inf").is_nan());
        assert!(js_number("12abc").is_nan());
    }

    #[test]
    fn serial_vers_aaaammjj() {
        assert_eq!(qlik_serial_to_ymd(46192), 20260619);
    }
}
