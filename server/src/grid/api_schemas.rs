//! CollectFlow — Validation des paramètres de l'API `/api/v1`
//! (port de `src/lib/api-schemas.ts`, schémas zod).
//!
//! Toute entrée utilisateur passe par ici : bornes de pagination, listes blanches
//! de tri, projection de champs. Les erreurs remontent en `400 bad_request` avec
//! le détail des issues zod (`parsed.error.issues`), pour que l'appelant sache
//! quoi corriger — voir [`Issues::to_json`].
//!
//! Les paramètres d'URL arrivent comme `Object.fromEntries(searchParams)` : une
//! table nom → valeur (la dernière occurrence l'emporte), cf. [`query_map`].

use super::gammes::GAMMES;
use super::store::{GridSortKey, GRID_SORT_KEYS};
use super::zod::{self, child, Issues, Seg};
use serde_json::{Map, Value};
use std::collections::HashMap;

/// `Object.fromEntries(req.nextUrl.searchParams)`.
pub fn query_map(pairs: Vec<(String, String)>) -> HashMap<String, String> {
    pairs.into_iter().collect()
}

fn p(k: &str) -> Vec<Seg> {
    vec![Seg::from(k)]
}

/// `z.string().min(1[, message]).optional()` sur un paramètre d'URL.
fn opt_non_vide(q: &HashMap<String, String>, k: &str, message: Option<&str>, issues: &mut Issues) -> Option<String> {
    let v = q.get(k)?;
    zod::check_len(v, &p(k), Some((1, message)), None, issues).then(|| v.clone())
}

/// `z.string().min(1, message)` obligatoire sur un paramètre d'URL.
fn requis(q: &HashMap<String, String>, k: &str, message: &str, issues: &mut Issues) -> Option<String> {
    match q.get(k) {
        None => {
            issues.invalid_type(&p(k), "string", None);
            None
        }
        Some(v) => zod::check_len(v, &p(k), Some((1, Some(message))), None, issues).then(|| v.clone()),
    }
}

/// `z.enum([...]).default(d)` / `.optional()` sur un paramètre d'URL.
fn enum_param(q: &HashMap<String, String>, k: &str, values: &[&str], defaut: Option<&str>, issues: &mut Issues) -> Option<String> {
    match q.get(k) {
        None => defaut.map(str::to_string),
        Some(v) if values.contains(&v.as_str()) => Some(v.clone()),
        Some(_) => {
            issues.invalid_value(&p(k), values, None);
            None
        }
    }
}

/// `z.coerce.number().int().min(1)` avec défaut éventuel.
fn int_param(q: &HashMap<String, String>, k: &str, defaut: Option<i64>, max: Option<f64>, issues: &mut Issues) -> Option<i64> {
    match q.get(k) {
        None => defaut,
        Some(v) => zod::coerce_int(v, &p(k), 1.0, max, issues),
    }
}

/// Message du tri inconnu (liste des clés acceptées).
pub fn message_tri_inconnu() -> String {
    format!("Tri inconnu. Valeurs acceptées : {}", GRID_SORT_KEYS.join(", "))
}

/// Paramètres de tri et de projection communs (`sortShape`).
#[derive(Debug, Clone, PartialEq)]
pub struct SortParams {
    pub sort: Option<String>,
    /// `"asc"` | `"desc"` (défaut `"desc"`).
    pub order: String,
    /// Liste de champs de ProductRow à conserver, séparés par des virgules.
    pub fields: Option<String>,
    /// `"1"` (défaut) : relit les métriques réseau Qlik et la gamme serveur au moment
    /// de l'appel. `"0"` : sert l'instantané brut, un peu plus rapide.
    pub enrich: String,
}

fn sort_shape(q: &HashMap<String, String>, issues: &mut Issues) -> SortParams {
    let sort = q.get("sort").and_then(|v| {
        if GRID_SORT_KEYS.contains(&v.as_str()) {
            Some(v.clone())
        } else {
            issues.custom(&p("sort"), &message_tri_inconnu());
            None
        }
    });
    let order = enum_param(q, "order", &["asc", "desc"], Some("desc"), issues).unwrap_or_default();
    let fields = q.get("fields").cloned();
    let enrich = enum_param(q, "enrich", &["0", "1"], Some("1"), issues).unwrap_or_default();
    SortParams { sort, order, fields, enrich }
}

/// `/api/v1/grid` — le fournisseur est obligatoire (recherche transversale : /products/search).
#[derive(Debug, Clone, PartialEq)]
pub struct GridQueryParams {
    pub fournisseur: String,
    pub gamme: Option<String>,
    pub code1: Option<String>,
    pub code2: Option<String>,
    pub code3: Option<String>,
    /// Préfixe de nomenclature (« 32 », « 3202 », « 320211 »), tel que renvoyé par
    /// /api/v1/nomenclatures. À préférer à code1/code2.
    pub nomenclature: Option<String>,
    pub search: Option<String>,
    /// `"1"` (défaut) : calcule l'instantané à la demande s'il n'existe pas encore ;
    /// `"0"` : comportement strict, échoue vite en `not_ready`.
    pub compute: String,
    pub sort: SortParams,
    pub page: i64,
    /// **Aucun plafond, et aucune valeur par défaut** : sans `limit`, `/grid`
    /// renvoie *toutes* les lignes du fournisseur.
    pub limit: Option<i64>,
}

const MESSAGE_NOMENCLATURE: &str = "La nomenclature doit être un préfixe numérique (ex. 32, 3202, 320211)";

/// `gridQuerySchema.safeParse(...)`.
pub fn parse_grid_query(q: &HashMap<String, String>) -> Result<GridQueryParams, Issues> {
    let mut issues = Issues::default();
    let fournisseur = requis(q, "fournisseur", "Paramètre 'fournisseur' requis", &mut issues);
    let gamme = opt_non_vide(q, "gamme", None, &mut issues);
    let code1 = opt_non_vide(q, "code1", None, &mut issues);
    let code2 = opt_non_vide(q, "code2", None, &mut issues);
    let code3 = opt_non_vide(q, "code3", None, &mut issues);
    let nomenclature = q.get("nomenclature").and_then(|v| {
        let chemin = p("nomenclature");
        let mut ok = zod::check_len(v, &chemin, Some((1, None)), Some((20, None)), &mut issues);
        if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
            issues.invalid_regex(&chemin, "/^[0-9]+$/", MESSAGE_NOMENCLATURE);
            ok = false;
        }
        ok.then(|| v.clone())
    });
    let search = opt_non_vide(q, "search", None, &mut issues);
    let compute = enum_param(q, "compute", &["0", "1"], Some("1"), &mut issues).unwrap_or_default();
    let sort = sort_shape(q, &mut issues);
    let page = int_param(q, "page", Some(1), None, &mut issues);
    let limit = int_param(q, "limit", None, None, &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(GridQueryParams {
        fournisseur: fournisseur.unwrap_or_default(),
        gamme,
        code1,
        code2,
        code3,
        nomenclature,
        search,
        compute,
        sort,
        page: page.unwrap_or(1),
        limit,
    })
}

/// `/api/v1/products/search` — `fournisseur` facultatif : c'est la recherche transversale.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductSearchParams {
    pub q: String,
    pub fournisseur: Option<String>,
    pub gamme: Option<String>,
    pub sort: SortParams,
    pub page: i64,
    /// Défaut 100, sans plafond.
    pub limit: i64,
}

/// `productSearchSchema.safeParse(...)`.
pub fn parse_product_search(q: &HashMap<String, String>) -> Result<ProductSearchParams, Issues> {
    let mut issues = Issues::default();
    let texte = match q.get("q") {
        None => {
            issues.invalid_type(&p("q"), "string", None);
            None
        }
        Some(v) => zod::check_len(v, &p("q"), Some((1, Some("Paramètre 'q' requis"))), Some((120, None)), &mut issues).then(|| v.clone()),
    };
    let fournisseur = opt_non_vide(q, "fournisseur", None, &mut issues);
    let gamme = opt_non_vide(q, "gamme", None, &mut issues);
    let sort = sort_shape(q, &mut issues);
    let page = int_param(q, "page", Some(1), None, &mut issues);
    let limit = int_param(q, "limit", Some(100), None, &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(ProductSearchParams { q: texte.unwrap_or_default(), fournisseur, gamme, sort, page: page.unwrap_or(1), limit: limit.unwrap_or(100) })
}

#[derive(Debug, Clone, PartialEq)]
pub struct FournisseursQueryParams {
    pub search: Option<String>,
    /// `"1"` = uniquement les fournisseurs déjà présents dans l'instantané de grille.
    pub with_data: Option<String>,
}

/// `fournisseursQuerySchema.safeParse(...)`.
pub fn parse_fournisseurs_query(q: &HashMap<String, String>) -> Result<FournisseursQueryParams, Issues> {
    let mut issues = Issues::default();
    let search = opt_non_vide(q, "search", None, &mut issues);
    let with_data = enum_param(q, "withData", &["0", "1"], None, &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(FournisseursQueryParams { search, with_data })
}

/// `/api/v1/nomenclatures` — inventaire des postes d'un fournisseur.
#[derive(Debug, Clone, PartialEq)]
pub struct NomenclaturesQueryParams {
    pub fournisseur: String,
    /// 1 = univers, 2 = famille, 3 = sous-famille (selon la nomenclature FF).
    pub niveau: u8,
    /// Restreint à un poste parent (préfixe).
    pub parent: Option<String>,
}

/// `nomenclaturesQuerySchema.safeParse(...)`.
pub fn parse_nomenclatures_query(q: &HashMap<String, String>) -> Result<NomenclaturesQueryParams, Issues> {
    let mut issues = Issues::default();
    let fournisseur = requis(q, "fournisseur", "Paramètre 'fournisseur' requis", &mut issues);
    let niveau = int_param(q, "niveau", Some(1), Some(3.0), &mut issues);
    let parent = opt_non_vide(q, "parent", None, &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(NomenclaturesQueryParams { fournisseur: fournisseur.unwrap_or_default(), niveau: niveau.unwrap_or(1).clamp(1, 3) as u8, parent })
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProductDetailParams {
    pub fournisseur: Option<String>,
    /// `"1"` (défaut) : calcule l'instantané à la demande si le produit n'y figure pas
    /// encore. Nécessite `fournisseur`, le calcul se faisant par lot fournisseur.
    pub compute: String,
}

/// `productDetailSchema.safeParse(...)`.
pub fn parse_product_detail(q: &HashMap<String, String>) -> Result<ProductDetailParams, Issues> {
    let mut issues = Issues::default();
    let fournisseur = opt_non_vide(q, "fournisseur", None, &mut issues);
    let compute = enum_param(q, "compute", &["0", "1"], Some("1"), &mut issues).unwrap_or_default();
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(ProductDetailParams { fournisseur, compute })
}

/// Message des gammes inconnues (`gammeShape`).
pub fn message_gamme_inconnue() -> String {
    let codes: Vec<&str> = GAMMES.iter().map(|g| g.code).collect();
    format!("Gamme inconnue. Valeurs acceptées : {}", codes.join(", "))
}

fn gamme_shape(v: Option<&Value>, chemin: &[Seg], issues: &mut Issues) -> Option<String> {
    let codes: Vec<&str> = GAMMES.iter().map(|g| g.code).collect();
    zod::enum_value(v, &codes, chemin, Some(&message_gamme_inconnue()), issues)
}

/// `z.boolean().default(true)`.
fn bool_defaut_vrai(o: &Map<String, Value>, k: &str, issues: &mut Issues) -> Option<bool> {
    match o.get(k) {
        None => Some(true),
        v => zod::boolean(v, &p(k), issues),
    }
}

/// `PUT /api/v1/products/:codein/gamme` — affecte ou change la gamme d'un article.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductGammeBody {
    pub gamme: String,
    /// Obligatoire seulement si l'article est référencé chez plusieurs fournisseurs.
    pub fournisseur: Option<String>,
    /// `true` (défaut) : calcule l'instantané du fournisseur s'il n'existe pas encore.
    pub compute: bool,
}

/// `productGammeBodySchema.safeParse(corps)`.
pub fn parse_product_gamme_body(corps: &Value) -> Result<ProductGammeBody, Issues> {
    let mut issues = Issues::default();
    let Some(o) = zod::object(Some(corps), &[], &mut issues) else { return Err(issues) };
    let gamme = gamme_shape(o.get("gamme"), &p("gamme"), &mut issues);
    let fournisseur = match o.get("fournisseur") {
        None => Some(None),
        v => zod::string(v, &p("fournisseur"), &mut issues)
            .and_then(|s| zod::check_len(&s, &p("fournisseur"), Some((1, None)), None, &mut issues).then_some(Some(s))),
    };
    let compute = bool_defaut_vrai(o, "compute", &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(ProductGammeBody { gamme: gamme.unwrap_or_default(), fournisseur: fournisseur.flatten(), compute: compute.unwrap_or(true) })
}

/// Un changement de `POST /api/v1/gammes`.
#[derive(Debug, Clone, PartialEq)]
pub struct GammeChange {
    pub codein: String,
    pub gamme: String,
}

/// `POST /api/v1/gammes` — affecte des gammes à plusieurs articles d'un fournisseur.
#[derive(Debug, Clone, PartialEq)]
pub struct GammesBatchBody {
    pub fournisseur: String,
    pub changes: Vec<GammeChange>,
    pub compute: bool,
}

/// `gammesBatchBodySchema.safeParse(corps)`.
pub fn parse_gammes_batch_body(corps: &Value) -> Result<GammesBatchBody, Issues> {
    let mut issues = Issues::default();
    let Some(o) = zod::object(Some(corps), &[], &mut issues) else { return Err(issues) };
    let fournisseur = zod::string(o.get("fournisseur"), &p("fournisseur"), &mut issues)
        .and_then(|s| zod::check_len(&s, &p("fournisseur"), Some((1, Some("Champ 'fournisseur' requis"))), None, &mut issues).then_some(s));
    let chemin = p("changes");
    let mut changes = Vec::new();
    match o.get("changes") {
        Some(Value::Array(a)) => {
            for (i, x) in a.iter().enumerate() {
                let ci = child(&chemin, i);
                let Some(c) = zod::object(Some(x), &ci, &mut issues) else { continue };
                let codein = zod::string(c.get("codein"), &child(&ci, "codein"), &mut issues)
                    .and_then(|s| zod::check_len(&s, &child(&ci, "codein"), Some((1, None)), None, &mut issues).then_some(s));
                let gamme = gamme_shape(c.get("gamme"), &child(&ci, "gamme"), &mut issues);
                if let (Some(codein), Some(gamme)) = (codein, gamme) {
                    changes.push(GammeChange { codein, gamme });
                }
            }
            if a.is_empty() {
                issues.too_small(&chemin, "array", 1.0, Some("Au moins un changement attendu"));
            }
            if a.len() > 10_000 {
                issues.too_big(&chemin, "array", 10_000.0, Some("10 000 changements au maximum par appel"));
            }
        }
        autre => issues.invalid_type(&chemin, "array", autre),
    }
    let compute = bool_defaut_vrai(o, "compute", &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(GammesBatchBody { fournisseur: fournisseur.unwrap_or_default(), changes, compute: compute.unwrap_or(true) })
}

/// Projection de champs : `?fields=codein,libelle1,totalCa`.
///
/// Sert à alléger la réponse — un `ProductRow` complet porte les séries mensuelles
/// et les ventilations par magasin, ce qui est volumineux sur plusieurs centaines de
/// lignes. `codein` est toujours conservé pour que la ligne reste identifiable.
pub fn pick_fields(row: Value, fields: Option<&str>) -> Value {
    let Some(fields) = fields.filter(|f| !f.is_empty()) else { return row };
    let mut wanted: Vec<&str> = Vec::new();
    for f in fields.split(',').map(super::js::js_trim).filter(|f| !f.is_empty()) {
        if !wanted.contains(&f) {
            wanted.push(f);
        }
    }
    if wanted.is_empty() {
        return row;
    }
    if !wanted.contains(&"codein") {
        wanted.push("codein");
    }
    let Value::Object(source) = row else { return row };
    let mut out = Map::new();
    for key in wanted {
        if let Some(v) = source.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    Value::Object(out)
}

/// Normalise le tri validé vers la clé attendue par grid-store.
pub fn to_sort_key(sort: Option<&str>) -> Option<GridSortKey> {
    sort.and_then(GridSortKey::from_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        query_map(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    fn issues_json(i: Issues) -> String {
        serde_json::to_string(&i.to_json()).unwrap()
    }

    #[test]
    fn grid_query_comme_zod() {
        let err = parse_grid_query(&q(&[
            ("fournisseur", "x"),
            ("nomenclature", ""),
            ("sort", "bad"),
            ("order", "up"),
            ("enrich", "2"),
            ("compute", "x"),
            ("page", "0"),
            ("limit", "-1"),
        ]))
        .unwrap_err();
        assert_eq!(
            issues_json(err),
            r#"[{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["nomenclature"],"message":"Too small: expected string to have >=1 characters"},{"origin":"string","code":"invalid_format","format":"regex","pattern":"/^[0-9]+$/","path":["nomenclature"],"message":"La nomenclature doit être un préfixe numérique (ex. 32, 3202, 320211)"},{"code":"invalid_value","values":["0","1"],"path":["compute"],"message":"Invalid option: expected one of \"0\"|\"1\""},{"code":"custom","path":["sort"],"message":"Tri inconnu. Valeurs acceptées : libelle1, codein, codeFournisseur, codeGamme, totalCa, totalQuantite, totalMarge, tauxMarge, stockActuel, caReseau, qteReseau, nbMagasinsReseau, caParMagasinReseau, computedAt"},{"code":"invalid_value","values":["asc","desc"],"path":["order"],"message":"Invalid option: expected one of \"asc\"|\"desc\""},{"code":"invalid_value","values":["0","1"],"path":["enrich"],"message":"Invalid option: expected one of \"0\"|\"1\""},{"origin":"number","code":"too_small","minimum":1,"inclusive":true,"path":["page"],"message":"Too small: expected number to be >=1"},{"origin":"number","code":"too_small","minimum":1,"inclusive":true,"path":["limit"],"message":"Too small: expected number to be >=1"}]"#
        );
        let err = parse_grid_query(&q(&[("fournisseur", "x"), ("nomenclature", "123456789012345678901a")])).unwrap_err();
        assert_eq!(
            issues_json(err),
            r#"[{"origin":"string","code":"too_big","maximum":20,"inclusive":true,"path":["nomenclature"],"message":"Too big: expected string to have <=20 characters"},{"origin":"string","code":"invalid_format","format":"regex","pattern":"/^[0-9]+$/","path":["nomenclature"],"message":"La nomenclature doit être un préfixe numérique (ex. 32, 3202, 320211)"}]"#
        );
        let ok = parse_grid_query(&q(&[("fournisseur", "x")])).unwrap();
        assert_eq!((ok.compute.as_str(), ok.sort.order.as_str(), ok.sort.enrich.as_str(), ok.page, ok.limit), ("1", "desc", "1", 1, None));
        let ok = parse_grid_query(&q(&[("fournisseur", "x"), ("page", "2"), ("limit", "50"), ("sort", "codein"), ("fields", "")])).unwrap();
        assert_eq!((ok.page, ok.limit, ok.sort.sort.as_deref(), ok.sort.fields.as_deref()), (2, Some(50), Some("codein"), Some("")));
    }

    #[test]
    fn autres_schemas_comme_zod() {
        assert_eq!(
            issues_json(parse_nomenclatures_query(&q(&[])).unwrap_err()),
            r#"[{"expected":"string","code":"invalid_type","path":["fournisseur"],"message":"Invalid input: expected string, received undefined"}]"#
        );
        assert_eq!(
            issues_json(parse_nomenclatures_query(&q(&[("fournisseur", "x"), ("niveau", "4"), ("parent", "")])).unwrap_err()),
            r#"[{"origin":"number","code":"too_big","maximum":3,"inclusive":true,"path":["niveau"],"message":"Too big: expected number to be <=3"},{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["parent"],"message":"Too small: expected string to have >=1 characters"}]"#
        );
        assert_eq!(parse_nomenclatures_query(&q(&[("fournisseur", "x"), ("niveau", "2.0")])).unwrap().niveau, 2);
        assert_eq!(
            issues_json(parse_fournisseurs_query(&q(&[("withData", "2"), ("search", "")])).unwrap_err()),
            r#"[{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["search"],"message":"Too small: expected string to have >=1 characters"},{"code":"invalid_value","values":["0","1"],"path":["withData"],"message":"Invalid option: expected one of \"0\"|\"1\""}]"#
        );
        assert_eq!(
            issues_json(parse_product_search(&q(&[("q", "x"), ("page", "1.5"), ("limit", "0")])).unwrap_err()),
            r#"[{"expected":"int","format":"safeint","code":"invalid_type","path":["page"],"message":"Invalid input: expected int, received number"},{"origin":"number","code":"too_small","minimum":1,"inclusive":true,"path":["limit"],"message":"Too small: expected number to be >=1"}]"#
        );
        assert_eq!(parse_product_search(&q(&[("q", "x")])).unwrap().limit, 100);
        assert_eq!(
            issues_json(parse_product_detail(&q(&[("compute", "2")])).unwrap_err()),
            r#"[{"code":"invalid_value","values":["0","1"],"path":["compute"],"message":"Invalid option: expected one of \"0\"|\"1\""}]"#
        );
    }

    #[test]
    fn corps_comme_zod() {
        assert_eq!(
            issues_json(parse_product_gamme_body(&json!({ "gamme": "Q", "compute": "yes", "fournisseur": 3 })).unwrap_err()),
            r#"[{"code":"invalid_value","values":["A","B","C","Y","Z"],"path":["gamme"],"message":"Gamme inconnue. Valeurs acceptées : A, B, C, Y, Z"},{"expected":"string","code":"invalid_type","path":["fournisseur"],"message":"Invalid input: expected string, received number"},{"expected":"boolean","code":"invalid_type","path":["compute"],"message":"Invalid input: expected boolean, received string"}]"#
        );
        assert_eq!(
            issues_json(parse_product_gamme_body(&json!([])).unwrap_err()),
            r#"[{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received array"}]"#
        );
        assert_eq!(
            issues_json(parse_gammes_batch_body(&json!({ "fournisseur": "", "changes": [] })).unwrap_err()),
            r#"[{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["fournisseur"],"message":"Champ 'fournisseur' requis"},{"origin":"array","code":"too_small","minimum":1,"inclusive":true,"path":["changes"],"message":"Au moins un changement attendu"}]"#
        );
        assert_eq!(
            issues_json(parse_gammes_batch_body(&json!({ "changes": [{ "codein": "", "gamme": "Q" }, { "gamme": 1 }, 5] })).unwrap_err()),
            r#"[{"expected":"string","code":"invalid_type","path":["fournisseur"],"message":"Invalid input: expected string, received undefined"},{"origin":"string","code":"too_small","minimum":1,"inclusive":true,"path":["changes",0,"codein"],"message":"Too small: expected string to have >=1 characters"},{"code":"invalid_value","values":["A","B","C","Y","Z"],"path":["changes",0,"gamme"],"message":"Gamme inconnue. Valeurs acceptées : A, B, C, Y, Z"},{"expected":"string","code":"invalid_type","path":["changes",1,"codein"],"message":"Invalid input: expected string, received undefined"},{"code":"invalid_value","values":["A","B","C","Y","Z"],"path":["changes",1,"gamme"],"message":"Gamme inconnue. Valeurs acceptées : A, B, C, Y, Z"},{"expected":"object","code":"invalid_type","path":["changes",2],"message":"Invalid input: expected object, received number"}]"#
        );
        assert_eq!(
            issues_json(parse_gammes_batch_body(&json!({ "fournisseur": "f", "changes": "x", "compute": null })).unwrap_err()),
            r#"[{"expected":"array","code":"invalid_type","path":["changes"],"message":"Invalid input: expected array, received string"},{"expected":"boolean","code":"invalid_type","path":["compute"],"message":"Invalid input: expected boolean, received null"}]"#
        );
        let ok = parse_gammes_batch_body(&json!({ "fournisseur": "f", "changes": [{ "codein": "1", "gamme": "A" }] })).unwrap();
        assert!(ok.compute);
        assert_eq!(ok.changes, vec![GammeChange { codein: "1".into(), gamme: "A".into() }]);
    }

    #[test]
    fn projection_de_champs() {
        let row = json!({ "codein": "1", "libelle1": "L", "totalCa": 3, "gtin": "G" });
        assert_eq!(pick_fields(row.clone(), None), row);
        assert_eq!(pick_fields(row.clone(), Some(" , ")), row);
        let p = pick_fields(row, Some("totalCa, libelle1,absent"));
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"totalCa":3,"libelle1":"L","codein":"1"}"#);
        assert_eq!(to_sort_key(Some("caReseau")), Some(GridSortKey::CaReseau));
        assert_eq!(to_sort_key(Some("x")), None);
    }
}
