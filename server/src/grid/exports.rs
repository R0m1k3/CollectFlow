//! Exports Excel de la Grille (port de `src/app/api/export/excel/route.ts` et
//! `src/app/api/export/modified-gammes/route.ts`, ExcelJS → rust_xlsxwriter).
//!
//! Mêmes feuilles, colonnes, largeurs, styles d'en-tête, formats et noms de
//! fichier. Le découpage du fichier d'import des gammes en lots de 5 000 lignes
//! (`LIGNES_MAX_PAR_FICHIER_GAMMES`) se fait côté interface, qui appelle
//! `/api/export/modified-gammes` une fois par lot : la route ne fait que mettre en
//! forme les lignes reçues.

use super::js;
use super::zod::{self, child, Issues, Seg};
use crate::auth::SessionUser;
use crate::error::{AppError, AppResult};
use axum::body::Bytes;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, FormatPattern, Workbook, Worksheet, XlsxError};
use serde_json::{json, Value};

const CONTENT_TYPE_XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// Largeur ExcelJS (`width: 14`) : valeur écrite telle quelle dans `<col width>`.
/// rust_xlsxwriter ajoute la marge de cellule à une largeur en caractères ; en
/// pixels (7 px par caractère), il écrit exactement `width`.
fn largeur(ws: &mut Worksheet, col: u16, width: u32) -> Result<(), XlsxError> {
    ws.set_column_width_pixels(col, width * 7)?;
    Ok(())
}

/// Style d'en-tête commun aux deux exports.
fn style_entete() -> Format {
    Format::new()
        .set_bold()
        .set_font_color(Color::RGB(0xFFFFFF))
        .set_pattern(FormatPattern::Solid)
        .set_background_color(Color::RGB(0x0F172A))
        .set_align(FormatAlign::Center)
        .set_border_bottom(FormatBorder::Thin)
        .set_border_bottom_color(Color::RGB(0x334155))
}

fn xlsx_err(e: XlsxError) -> AppError {
    AppError::internal(e.to_string())
}

/// `await req.json()` : un corps illisible lève une exception (500 côté Next).
fn lire_json(body: &Bytes) -> AppResult<Value> {
    serde_json::from_slice(body).map_err(|e| AppError::internal(format!("Corps JSON illisible : {e}")))
}

fn payload_invalide() -> Response {
    (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid payload" }))).into_response()
}

/// `${prefixe}_${nomFournisseur.replace(/\s+/g, "_")}_${YYYY-MM-DD}.xlsx` (date UTC,
/// comme `toISOString().slice(0, 10)`).
pub fn nom_fichier(prefixe: &str, nom_fournisseur: &str) -> String {
    format!("{prefixe}_{}_{}.xlsx", js::replace_whitespace_runs(nom_fournisseur, "_"), chrono::Utc::now().format("%Y-%m-%d"))
}

/// `attachment; filename="…"`. Comme Node, l'en-tête est écrit octet par octet en
/// Latin-1 : un caractère au-delà de U+00FF (ou un caractère de contrôle) est
/// refusé, ce qui faisait échouer la route Next en 500.
pub fn content_disposition(filename: &str) -> AppResult<HeaderValue> {
    let mut octets = Vec::with_capacity(filename.len() + 32);
    octets.extend_from_slice(b"attachment; filename=\"");
    for c in filename.chars() {
        let v = c as u32;
        if v > 0xFF || (v < 0x20 && v != 0x09) || v == 0x7F {
            return Err(AppError::internal(format!("Invalid character in header content [\"Content-Disposition\"] : {c:?}")));
        }
        octets.push(v as u8);
    }
    octets.push(b'"');
    HeaderValue::from_bytes(&octets).map_err(|e| AppError::internal(e.to_string()))
}

fn reponse_xlsx(buffer: Vec<u8>, filename: &str) -> AppResult<Response> {
    let disposition = content_disposition(filename)?;
    Ok(([(header::CONTENT_TYPE, HeaderValue::from_static(CONTENT_TYPE_XLSX)), (header::CONTENT_DISPOSITION, disposition)], buffer)
        .into_response())
}

// ---------------------------------------------------------------------------
// POST /api/export/excel
// ---------------------------------------------------------------------------

/// Ligne de `ExportSchema`.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportRow {
    pub codein: String,
    pub libelle1: String,
    pub code3: String,
    pub libelle3: String,
    pub code_gamme: Option<String>,
    pub total_quantite: f64,
    pub total_ca: f64,
    pub taux_marge: f64,
    /// Before gamme for delta
    pub gamme_avant: Option<String>,
}

/// `ExportSchema.safeParse(body)` → `(nomFournisseur, rows)`.
pub fn parse_export(body: &Value) -> Result<(String, Vec<ExportRow>), Issues> {
    let mut issues = Issues::default();
    let Some(o) = zod::object(Some(body), &[], &mut issues) else { return Err(issues) };
    let nom = zod::string(o.get("nomFournisseur"), &[Seg::from("nomFournisseur")], &mut issues);
    let chemin = vec![Seg::from("rows")];
    let mut rows = Vec::new();
    match o.get("rows") {
        Some(Value::Array(a)) => {
            for (i, x) in a.iter().enumerate() {
                let ci = child(&chemin, i);
                let Some(r) = zod::object(Some(x), &ci, &mut issues) else { continue };
                let s = |k: &str, issues: &mut Issues| zod::string(r.get(k), &child(&ci, k), issues);
                let codein = s("codein", &mut issues);
                let libelle1 = s("libelle1", &mut issues);
                let code3 = s("code3", &mut issues);
                let libelle3 = s("libelle3", &mut issues);
                let code_gamme = zod::nullable_string(r.get("codeGamme"), &child(&ci, "codeGamme"), &mut issues);
                let n = |k: &str, issues: &mut Issues| zod::number(r.get(k), &child(&ci, k), issues);
                let total_quantite = n("totalQuantite", &mut issues);
                let total_ca = n("totalCa", &mut issues);
                let taux_marge = n("tauxMarge", &mut issues);
                let gamme_avant = match r.get("gammeAvant") {
                    None => Some(None),
                    v => zod::nullable_string(v, &child(&ci, "gammeAvant"), &mut issues),
                };
                if let (
                    Some(codein),
                    Some(libelle1),
                    Some(code3),
                    Some(libelle3),
                    Some(code_gamme),
                    Some(total_quantite),
                    Some(total_ca),
                    Some(taux_marge),
                    Some(gamme_avant),
                ) = (codein, libelle1, code3, libelle3, code_gamme, total_quantite, total_ca, taux_marge, gamme_avant)
                {
                    rows.push(ExportRow {
                        codein,
                        libelle1,
                        code3,
                        libelle3,
                        code_gamme,
                        total_quantite,
                        total_ca,
                        taux_marge,
                        gamme_avant,
                    });
                }
            }
        }
        autre => issues.invalid_type(&chemin, "array", autre),
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok((nom.unwrap_or_default(), rows))
}

/// Gamme colours
fn couleur_gamme(code: &str) -> Option<u32> {
    match code {
        "A" => Some(0x064E3B),
        "B" => Some(0x1E3A5F),
        "C" => Some(0x78350F),
        "Z" => Some(0x4C0519),
        _ => None,
    }
}

/// Classeur « Assortiment » (tous les produits, gamme avant/après, chiffres 12 mois).
pub fn classeur_assortiment(rows: &[ExportRow]) -> Result<Vec<u8>, XlsxError> {
    let mut workbook = Workbook::new();
    workbook.set_properties(&rust_xlsxwriter::DocProperties::new().set_author("CollectFlow"));
    let sheet = workbook.add_worksheet();
    sheet.set_name("Assortiment")?;
    sheet.set_freeze_panes(1, 0)?;

    let entete = style_entete();
    let colonnes: [(&str, u32); 9] = [
        ("Code", 14),
        ("Désignation", 40),
        ("Nomenclature", 25),
        ("Gamme Avant", 14),
        ("Gamme Après", 14),
        ("Delta", 10),
        ("Vol. 12m", 12),
        ("CA 12m (€)", 14),
        ("Marge (%)", 12),
    ];
    for (i, (titre, w)) in colonnes.iter().enumerate() {
        largeur(sheet, i as u16, *w)?;
        sheet.write_string_with_format(0, i as u16, *titre, &entete)?;
    }
    sheet.set_row_height(0, 22)?;

    let fmt_ca = Format::new().set_num_format("#,##0.00 \"€\"");
    let fmt_marge = Format::new().set_num_format("0.00\"%\"");
    let fmt_delta = Format::new().set_bold().set_font_color(Color::RGB(0xFBBF24));

    for (i, row) in rows.iter().enumerate() {
        let r = (i + 1) as u32;
        let delta = if row.gamme_avant != row.code_gamme {
            format!("{} → {}", row.gamme_avant.as_deref().unwrap_or("—"), row.code_gamme.as_deref().unwrap_or("—"))
        } else {
            String::new()
        };
        sheet.write_string(r, 0, &row.codein)?;
        sheet.write_string(r, 1, &row.libelle1)?;
        sheet.write_string(r, 2, &row.libelle3)?;
        sheet.write_string(r, 3, row.gamme_avant.as_deref().unwrap_or("—"))?;

        // Colour the "Gamme Après" cell
        let gamme_apres = row.code_gamme.as_deref().unwrap_or("—");
        match row.code_gamme.as_deref().and_then(couleur_gamme) {
            Some(c) => {
                let f = Format::new()
                    .set_pattern(FormatPattern::Solid)
                    .set_background_color(Color::RGB(c))
                    .set_bold()
                    .set_font_color(Color::RGB(0xFFFFFF));
                sheet.write_string_with_format(r, 4, gamme_apres, &f)?;
            }
            None => {
                sheet.write_string(r, 4, gamme_apres)?;
            }
        }

        // Highlight changed rows
        if delta.is_empty() {
            sheet.write_string(r, 5, &delta)?;
        } else {
            sheet.write_string_with_format(r, 5, &delta, &fmt_delta)?;
        }

        sheet.write_number(r, 6, js::js_round(row.total_quantite))?;
        // Format numbers
        sheet.write_number_with_format(r, 7, js::js_to_fixed2(row.total_ca), &fmt_ca)?;
        sheet.write_number_with_format(r, 8, js::js_to_fixed2(row.taux_marge), &fmt_marge)?;
    }

    workbook.save_to_buffer()
}

/// `POST /api/export/excel`.
pub async fn export_excel(SessionUser(_utilisateur): SessionUser, body: Bytes) -> AppResult<Response> {
    let body = lire_json(&body)?;
    let Ok((nom_fournisseur, rows)) = parse_export(&body) else { return Ok(payload_invalide()) };
    let buffer = classeur_assortiment(&rows).map_err(xlsx_err)?;
    reponse_xlsx(buffer, &nom_fichier("Assortiment", &nom_fournisseur))
}

// ---------------------------------------------------------------------------
// POST /api/export/modified-gammes
// ---------------------------------------------------------------------------

/// Ligne de `ExportModifiedGammesSchema`.
#[derive(Debug, Clone, PartialEq)]
pub struct GammeModifiee {
    pub codein: String,
    pub gtin: String,
    pub code_fournisseur: Option<String>,
    pub gamme: String,
}

/// `ExportModifiedGammesSchema.safeParse(body)` → `(nomFournisseur, changes)`.
pub fn parse_modified_gammes(body: &Value) -> Result<(String, Vec<GammeModifiee>), Issues> {
    let mut issues = Issues::default();
    let Some(o) = zod::object(Some(body), &[], &mut issues) else { return Err(issues) };
    let nom = zod::string(o.get("nomFournisseur"), &[Seg::from("nomFournisseur")], &mut issues);
    let chemin = vec![Seg::from("changes")];
    let mut changes = Vec::new();
    match o.get("changes") {
        Some(Value::Array(a)) => {
            for (i, x) in a.iter().enumerate() {
                let ci = child(&chemin, i);
                let Some(r) = zod::object(Some(x), &ci, &mut issues) else { continue };
                let codein = zod::string(r.get("codein"), &child(&ci, "codein"), &mut issues);
                let gtin = zod::string(r.get("gtin"), &child(&ci, "gtin"), &mut issues);
                let code_fournisseur = zod::opt_string(r.get("codeFournisseur"), &child(&ci, "codeFournisseur"), &mut issues);
                let gamme = zod::string(r.get("gamme"), &child(&ci, "gamme"), &mut issues);
                if let (Some(codein), Some(gtin), Some(code_fournisseur), Some(gamme)) = (codein, gtin, code_fournisseur, gamme) {
                    changes.push(GammeModifiee { codein, gtin, code_fournisseur, gamme });
                }
            }
        }
        autre => issues.invalid_type(&chemin, "array", autre),
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok((nom.unwrap_or_default(), changes))
}

/// `x || "—"`.
fn ou_tiret(s: &str) -> &str {
    if s.is_empty() {
        "—"
    } else {
        s
    }
}

/// Classeur « Gammes Modifiées » (CODE FOURNISSEUR, CODEIN, GAMME) : le fichier
/// d'import des gammes.
pub fn classeur_gammes_modifiees(changes: &[GammeModifiee]) -> Result<Vec<u8>, XlsxError> {
    let mut workbook = Workbook::new();
    workbook.set_properties(&rust_xlsxwriter::DocProperties::new().set_author("CollectFlow"));
    let sheet = workbook.add_worksheet();
    sheet.set_name("Gammes Modifiées")?;
    sheet.set_freeze_panes(1, 0)?;

    // Format en texte pour eviter la notation scientifique excel ; centrer la
    // colonne Gamme. ExcelJS applique ces styles de colonne à toutes les cellules
    // déjà écrites, en-tête compris. « @ » = format intégré n° 49, comme ExcelJS.
    let texte = Format::new().set_num_format_index(49);
    let centre = Format::new().set_align(FormatAlign::Center);
    let entete = style_entete();
    let entete_texte = style_entete().set_num_format_index(49);

    largeur(sheet, 0, 22)?;
    largeur(sheet, 1, 18)?;
    largeur(sheet, 2, 12)?;
    sheet.set_column_format(0, &texte)?;
    sheet.set_column_format(1, &texte)?;
    sheet.set_column_format(2, &centre)?;

    sheet.write_string_with_format(0, 0, "CODE FOURNISSEUR", &entete_texte)?;
    sheet.write_string_with_format(0, 1, "CODEIN", &entete_texte)?;
    sheet.write_string_with_format(0, 2, "GAMME", &entete)?;
    sheet.set_row_height(0, 22)?;

    for (i, row) in changes.iter().enumerate() {
        let r = (i + 1) as u32;
        sheet.write_string_with_format(r, 0, ou_tiret(row.code_fournisseur.as_deref().unwrap_or("")), &texte)?;
        sheet.write_string_with_format(r, 1, ou_tiret(&row.codein), &texte)?;
        sheet.write_string_with_format(r, 2, ou_tiret(&row.gamme), &centre)?;
    }

    workbook.save_to_buffer()
}

/// `POST /api/export/modified-gammes`.
pub async fn export_modified_gammes(SessionUser(_utilisateur): SessionUser, body: Bytes) -> AppResult<Response> {
    let body = lire_json(&body)?;
    let Ok((nom_fournisseur, changes)) = parse_modified_gammes(&body) else { return Ok(payload_invalide()) };
    let buffer = classeur_gammes_modifiees(&changes).map_err(xlsx_err)?;
    reponse_xlsx(buffer, &nom_fichier("Modifications_Gammes", &nom_fournisseur))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Écrit les deux classeurs d'exemple dans `GRID_EXPORT_DIR` (pour inspection).
    #[test]
    fn classeurs_d_exemple() {
        let (_, rows) = parse_export(&json!({
            "nomFournisseur": "Le Fournisseur",
            "rows": [
                { "codein": "123456", "libelle1": "Bougie parfumée", "code3": "320211", "libelle3": "Bougies", "codeGamme": "A", "totalQuantite": 12.5, "totalCa": 1234.125, "tauxMarge": 41.2345, "gammeAvant": "B" },
                { "codein": "000789", "libelle1": "Vase", "code3": "320212", "libelle3": "Vases", "codeGamme": null, "totalQuantite": -2.5, "totalCa": 10, "tauxMarge": 0, "gammeAvant": null },
                { "codein": "42", "libelle1": "", "code3": "", "libelle3": "", "codeGamme": "Y", "totalQuantite": 3, "totalCa": 0.125, "tauxMarge": 1.005, "gammeAvant": "Y" }
            ]
        }))
        .unwrap();
        let a = classeur_assortiment(&rows).unwrap();
        let (_, changes) = parse_modified_gammes(&json!({
            "nomFournisseur": "X",
            "changes": [
                { "codein": "000123", "gtin": "3700", "codeFournisseur": "F001", "gamme": "A" },
                { "codein": "", "gtin": "", "gamme": "" }
            ]
        }))
        .unwrap();
        let b = classeur_gammes_modifiees(&changes).unwrap();
        assert!(a.starts_with(b"PK") && b.starts_with(b"PK"));
        if let Ok(dir) = std::env::var("GRID_EXPORT_DIR") {
            std::fs::write(format!("{dir}/rust_excel.xlsx"), a).unwrap();
            std::fs::write(format!("{dir}/rust_modified.xlsx"), b).unwrap();
        }
    }

    #[test]
    fn validation_et_entetes() {
        assert!(parse_export(&json!({ "nomFournisseur": "x", "rows": [{ "codein": "a" }] })).is_err());
        assert!(parse_export(&json!({ "nomFournisseur": "x", "rows": [] })).is_ok());
        assert!(parse_modified_gammes(
            &json!({ "nomFournisseur": "x", "changes": [{ "codein": "a", "gtin": "g", "gamme": "A", "codeFournisseur": 3 }] })
        )
        .is_err());
        let nom = nom_fichier("Assortiment", "Le  Fournisseur\tÉté");
        assert!(nom.starts_with("Assortiment_Le_Fournisseur_Été_") && nom.ends_with(".xlsx"));
        let h = content_disposition("Assortiment_Été.xlsx").unwrap();
        assert_eq!(h.as_bytes(), b"attachment; filename=\"Assortiment_\xc9t\xe9.xlsx\"");
        assert!(content_disposition("Fournisseur_œ.xlsx").is_err());
    }
}
