//! CollectFlow — Instantané persisté de la grille (table `grid_rows`),
//! port de `src/lib/grid-store.ts`.
//!
//! `getProductRows()` reconstruit la grille en direct (6 requêtes SQL sur la base
//! miroir FF + jointure Qlik) et ne la garde qu'en mémoire 10 minutes. L'API `/api/v1`
//! ne doit **jamais** déclencher ce calcul : elle lit cette table, remplie en effet de
//! bord quand quelqu'un ouvre la Grille.
//!
//! On n'introduit donc aucun calcul supplémentaire — on arrête de jeter un résultat
//! qui existe déjà, et il survit désormais aux redémarrages.

use super::js;
use super::types::ProductRow;
use crate::db;
use crate::error::{AppError, AppResult};
use chrono::{Datelike, NaiveDateTime, TimeZone};
use serde::Serialize;
use serde_json::Value;
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::HashMap;

/// Colonnes autorisées au tri — liste blanche, jamais l'entrée utilisateur brute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridSortKey {
    Libelle1,
    Codein,
    CodeFournisseur,
    CodeGamme,
    TotalCa,
    TotalQuantite,
    TotalMarge,
    TauxMarge,
    StockActuel,
    CaReseau,
    QteReseau,
    NbMagasinsReseau,
    CaParMagasinReseau,
    ComputedAt,
}

/// `SORTABLE` : clé exposée → colonne SQL.
const SORTABLE: [(GridSortKey, &str, &str); 14] = [
    (GridSortKey::Libelle1, "libelle1", "libelle1"),
    (GridSortKey::Codein, "codein", "codein"),
    (GridSortKey::CodeFournisseur, "codeFournisseur", "code_fournisseur"),
    (GridSortKey::CodeGamme, "codeGamme", "code_gamme"),
    (GridSortKey::TotalCa, "totalCa", "total_ca"),
    (GridSortKey::TotalQuantite, "totalQuantite", "total_quantite"),
    (GridSortKey::TotalMarge, "totalMarge", "total_marge"),
    (GridSortKey::TauxMarge, "tauxMarge", "taux_marge"),
    (GridSortKey::StockActuel, "stockActuel", "stock_actuel"),
    (GridSortKey::CaReseau, "caReseau", "ca_reseau"),
    (GridSortKey::QteReseau, "qteReseau", "qte_reseau"),
    (GridSortKey::NbMagasinsReseau, "nbMagasinsReseau", "nb_magasins_reseau"),
    (GridSortKey::CaParMagasinReseau, "caParMagasinReseau", "ca_par_magasin_reseau"),
    (GridSortKey::ComputedAt, "computedAt", "computed_at"),
];

/// `GRID_SORT_KEYS`, dans l'ordre de `SORTABLE`.
pub const GRID_SORT_KEYS: [&str; 14] = [
    "libelle1",
    "codein",
    "codeFournisseur",
    "codeGamme",
    "totalCa",
    "totalQuantite",
    "totalMarge",
    "tauxMarge",
    "stockActuel",
    "caReseau",
    "qteReseau",
    "nbMagasinsReseau",
    "caParMagasinReseau",
    "computedAt",
];

impl GridSortKey {
    /// Clé de tri depuis son nom exposé ; `None` hors liste blanche.
    pub fn from_key(key: &str) -> Option<Self> {
        SORTABLE.iter().find(|(_, k, _)| *k == key).map(|(s, _, _)| *s)
    }
    pub fn as_str(self) -> &'static str {
        SORTABLE.iter().find(|(s, _, _)| *s == self).map(|(_, k, _)| *k).unwrap_or("totalCa")
    }
    /// Colonne SQL (constante du code, jamais l'entrée utilisateur).
    fn column(self) -> &'static str {
        SORTABLE.iter().find(|(s, _, _)| *s == self).map(|(_, _, c)| *c).unwrap_or("total_ca")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortOrder {
    Asc,
    #[default]
    Desc,
}

#[derive(Debug, Clone, Default)]
pub struct GridQuery {
    pub code_fournisseur: Option<String>,
    pub gamme: Option<String>,
    pub code1: Option<String>,
    pub code2: Option<String>,
    pub code3: Option<String>,
    /// Préfixe de nomenclature (« 32 », « 3202 », « 320211 ») — filtre sur code3.
    pub nomenclature: Option<String>,
    /// Recherche libre : libellé, codein, GTIN, référence, code centrale.
    pub search: Option<String>,
    pub sort: Option<GridSortKey>,
    pub order: Option<SortOrder>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridQueryResult {
    pub rows: Vec<ProductRow>,
    pub total: i64,
    /// Calcul le plus ancien parmi les lignes renvoyées — fraîcheur de la donnée.
    pub computed_at: Option<String>,
}

/// Version du format des lignes persistées. À incrémenter dès qu'un champ de
/// `ProductRow` est ajouté ou change de sens : les instantanés plus anciens ne
/// seront plus servis à la Grille (recalcul), mais restent lisibles par /api/v1.
pub const GRID_PAYLOAD_VERSION: f64 = 1.0;

/// Lots d'écriture : payload jsonb volumineux, lots plus petits que pour des scalaires.
const CHUNK_UPSERT: usize = 200;
/// Bien en deçà des 65 535 paramètres liés de PostgreSQL.
const CHUNK_CODEINS: usize = 5000;

/// Chaîne non vide (`if (q.x)` côté TS).
fn renseigne(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|v| !v.is_empty())
}

/// Horodatage façon `new Date()` stocké par drizzle (UTC, à la milliseconde).
fn maintenant_utc_ms() -> NaiveDateTime {
    use chrono::Timelike;
    let now = chrono::Utc::now().naive_utc();
    now.with_nanosecond(now.nanosecond() / 1_000_000 * 1_000_000).unwrap_or(now)
}

/// Colonne `numeric` : le TS passe `String(n)` ; on fait de même (texte casté).
fn push_numeric(b: &mut sqlx::query_builder::Separated<'_, '_, Postgres, &'static str>, v: Option<f64>) {
    b.push("CAST(");
    b.push_bind_unseparated(v.map(js::numeric_text));
    b.push_unseparated(" AS numeric)");
}

/// Persiste les lignes calculées pour un fournisseur.
///
/// Stratégie : toutes les lignes du lot portent le même `computedAt`, puis on supprime
/// celles du fournisseur restées sur un `computedAt` antérieur. Cela purge les articles
/// disparus du catalogue sans avoir à passer des centaines de codein en paramètres.
pub async fn upsert_grid_rows(code_fournisseur: &str, rows: &[ProductRow]) -> AppResult<usize> {
    if code_fournisseur.is_empty() || rows.is_empty() {
        return Ok(0);
    }
    let values: Vec<&ProductRow> = rows.iter().filter(|r| !r.codein.is_empty()).collect();
    upsert_lots(code_fournisseur, values.len(), |plage| values[plage].iter().map(|r| (*r).clone()).collect()).await
}

/// Même écriture depuis les lignes partagées du cache mémoire : chaque lot est
/// copié sous verrou, puis écrit sans le tenir (pas de copie intégrale d'un
/// fournisseur de 130 000 articles).
pub async fn upsert_grid_rows_shared(code_fournisseur: &str, rows: &super::rows_cache::GridRows) -> AppResult<usize> {
    let indices: Vec<usize> = {
        let lignes = rows.rows.read();
        if code_fournisseur.is_empty() || lignes.is_empty() {
            return Ok(0);
        }
        lignes.iter().enumerate().filter(|(_, r)| !r.codein.is_empty()).map(|(i, _)| i).collect()
    };
    upsert_lots(code_fournisseur, indices.len(), |plage| {
        let lignes = rows.rows.read();
        indices[plage].iter().filter_map(|i| lignes.get(*i).cloned()).collect()
    })
    .await
}

/// Écrit `nb` lignes par lots de [`CHUNK_UPSERT`] (`lot(plage)` fournit les lignes
/// d'une plage), puis purge les lignes du fournisseur restées sur un calcul antérieur.
async fn upsert_lots(code_fournisseur: &str, nb: usize, lot: impl Fn(std::ops::Range<usize>) -> Vec<ProductRow>) -> AppResult<usize> {
    if nb == 0 {
        return Ok(0);
    }
    let pool = db::pool()?;
    let computed_at = maintenant_utc_ms();

    let mut written = 0usize;
    for debut in (0..nb).step_by(CHUNK_UPSERT) {
        let batch = lot(debut..(debut + CHUNK_UPSERT).min(nb));
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            "insert into grid_rows (code_fournisseur, codein, nom_fournisseur, libelle1, gtin, reference, \
             code_centrale, code1, code2, code3, code_gamme, code_gamme_init, total_ca, total_quantite, \
             total_marge, taux_marge, stock_actuel, ca_reseau, qte_reseau, nb_magasins_reseau, \
             ca_par_magasin_reseau, marge_pct_reseau, payload, computed_at) ",
        );
        let mut erreur_payload = None;
        qb.push_values(batch.iter(), |mut b, r| {
            let mut payload = r.clone();
            payload.payload_version = Some(GRID_PAYLOAD_VERSION);
            let payload = serde_json::to_value(&payload).unwrap_or_else(|e| {
                erreur_payload = Some(e.to_string());
                Value::Null
            });
            b.push_bind(code_fournisseur.to_string())
                .push_bind(r.codein.clone())
                .push_bind(r.nom_fournisseur.clone())
                .push_bind(r.libelle1.clone())
                .push_bind(r.gtin.clone())
                .push_bind(r.reference.clone())
                .push_bind(r.code_centrale.clone())
                .push_bind(r.code1.clone())
                .push_bind(r.code2.clone())
                .push_bind(r.code3.clone())
                .push_bind(r.code_gamme.clone())
                .push_bind(r.code_gamme_init.clone());
            push_numeric(&mut b, Some(r.total_ca));
            push_numeric(&mut b, Some(r.total_quantite));
            push_numeric(&mut b, Some(r.total_marge));
            push_numeric(&mut b, Some(r.taux_marge));
            push_numeric(&mut b, r.stock_actuel);
            push_numeric(&mut b, r.ca_reseau);
            push_numeric(&mut b, r.qte_reseau);
            // Colonne integer : le TS passe le nombre tel quel.
            b.push("CAST(");
            b.push_bind_unseparated(r.nb_magasins_reseau.map(js::numeric_text));
            b.push_unseparated(" AS integer)");
            push_numeric(&mut b, r.ca_par_magasin_reseau);
            push_numeric(&mut b, r.marge_pct_reseau);
            b.push_bind(payload).push_bind(computed_at);
        });
        if let Some(e) = erreur_payload {
            return Err(AppError::internal(e));
        }
        qb.push(
            " on conflict (code_fournisseur, codein) do update set \
             nom_fournisseur = excluded.nom_fournisseur, libelle1 = excluded.libelle1, gtin = excluded.gtin, \
             reference = excluded.reference, code_centrale = excluded.code_centrale, code1 = excluded.code1, \
             code2 = excluded.code2, code3 = excluded.code3, code_gamme = excluded.code_gamme, \
             code_gamme_init = excluded.code_gamme_init, total_ca = excluded.total_ca, \
             total_quantite = excluded.total_quantite, total_marge = excluded.total_marge, \
             taux_marge = excluded.taux_marge, stock_actuel = excluded.stock_actuel, ca_reseau = excluded.ca_reseau, \
             qte_reseau = excluded.qte_reseau, nb_magasins_reseau = excluded.nb_magasins_reseau, \
             ca_par_magasin_reseau = excluded.ca_par_magasin_reseau, marge_pct_reseau = excluded.marge_pct_reseau, \
             payload = excluded.payload, computed_at = excluded.computed_at",
        );
        qb.build().execute(&pool).await?;
        written += batch.len();
    }

    // Purge des articles qui ne font plus partie du catalogue du fournisseur.
    sqlx::query("delete from grid_rows where code_fournisseur = $1 and computed_at < $2")
        .bind(code_fournisseur)
        .bind(computed_at)
        .execute(&pool)
        .await?;

    Ok(written)
}

/// Instantané complet d'un fournisseur, tel que persisté par le dernier calcul.
pub struct GridSnapshot {
    pub rows: Vec<ProductRow>,
    /// Calcul le plus ancien des lignes (UTC).
    pub computed_at: NaiveDateTime,
}

/// Instantané complet d'un fournisseur, tel que persisté par le dernier calcul.
///
/// Renvoie `None` (→ recalcul) si rien n'est persisté, si une ligne est d'une
/// version de format antérieure, ou si le calcul date d'un autre mois que le mois
/// en cours : la fenêtre des 12 mois glissants aurait changé entre-temps.
/// Les lignes sont rendues dans l'ordre du calcul en direct (identifiant article).
pub async fn read_grid_snapshot(code_fournisseur: &str) -> AppResult<Option<GridSnapshot>> {
    let pool = db::pool()?;
    let found = sqlx::query("select payload, computed_at from grid_rows where code_fournisseur = $1")
        .bind(code_fournisseur)
        .fetch_all(&pool)
        .await?;
    if found.is_empty() {
        return Ok(None);
    }

    let mut oldest: Option<NaiveDateTime> = None;
    let mut rows = Vec::with_capacity(found.len());
    for r in &found {
        let payload: Value = r.try_get("payload")?;
        if payload.get("payloadVersion").and_then(Value::as_f64) != Some(GRID_PAYLOAD_VERSION) {
            return Ok(None);
        }
        let row: ProductRow = match serde_json::from_value(payload) {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!("[grid-store] payload illisible pour {code_fournisseur} : {}", crate::error::short(&e, 200));
                return Ok(None);
            }
        };
        let computed_at: NaiveDateTime = r.try_get("computed_at")?;
        if oldest.map(|o| computed_at < o).unwrap_or(true) {
            oldest = Some(computed_at);
        }
        rows.push(row);
    }
    let Some(oldest) = oldest else { return Ok(None) };
    // Comparaison en heure locale, comme `getFullYear()` / `getMonth()`.
    let local = chrono::Local.from_utc_datetime(&oldest);
    let now = chrono::Local::now();
    if local.year() != now.year() || local.month() != now.month() {
        return Ok(None);
    }
    rows.sort_by(|a, b| {
        let (x, y) = (a.noid.unwrap_or(0.0), b.noid.unwrap_or(0.0));
        (x - y).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(Some(GridSnapshot { rows, computed_at: oldest }))
}

/// Reporte des gammes enregistrées dans l'instantané persisté (colonne et payload),
/// pour que /api/v1 les voie sans attendre un recalcul complet de la grille.
pub async fn update_grid_rows_gamme<'a>(code_fournisseur: &str, changes: impl IntoIterator<Item = (&'a str, &'a str)>) -> AppResult<()> {
    // Map TS : ordre de première apparition de chaque gamme.
    let mut par_gamme: Vec<(String, Vec<String>)> = Vec::new();
    for (codein, gamme) in changes {
        match par_gamme.iter_mut().find(|(g, _)| g == gamme) {
            Some((_, codeins)) => codeins.push(codein.to_string()),
            None => par_gamme.push((gamme.to_string(), vec![codein.to_string()])),
        }
    }
    if par_gamme.is_empty() {
        return Ok(());
    }
    let pool = db::pool()?;
    for (gamme, codeins) in &par_gamme {
        for lot in codeins.chunks(CHUNK_CODEINS) {
            sqlx::query(
                "update grid_rows set code_gamme = $1, payload = jsonb_set(payload, '{codeGamme}', to_jsonb($2::text)) \
                 where code_fournisseur = $3 and codein = any($4)",
            )
            .bind(gamme)
            .bind(gamme)
            .bind(code_fournisseur)
            .bind(lot)
            .execute(&pool)
            .await?;
        }
    }
    Ok(())
}

/// Construit la clause WHERE commune à la grille et à la recherche transversale.
fn push_where(qb: &mut QueryBuilder<'_, Postgres>, q: &GridQuery) {
    let mut premiere = true;
    let mut et = |qb: &mut QueryBuilder<'_, Postgres>| {
        qb.push(if premiere { " where (" } else { " and " });
        premiere = false;
    };
    if let Some(v) = renseigne(&q.code_fournisseur) {
        et(qb);
        qb.push("code_fournisseur = ").push_bind(v.to_string());
    }
    if let Some(v) = renseigne(&q.gamme) {
        et(qb);
        qb.push("code_gamme = ").push_bind(v.to_string());
    }
    if let Some(v) = renseigne(&q.code1) {
        et(qb);
        qb.push("code1 = ").push_bind(v.to_string());
    }
    if let Some(v) = renseigne(&q.code2) {
        et(qb);
        qb.push("code2 = ").push_bind(v.to_string());
    }
    if let Some(v) = renseigne(&q.code3) {
        et(qb);
        qb.push("code3 = ").push_bind(v.to_string());
    }
    // Filtre par **préfixe** de nomenclature : « 32 », « 3202 » ou « 320211 ».
    // C'est celui à utiliser avec /api/v1/nomenclatures, car il ne dépend pas de
    // code1/code2 — parfois vides quand la hiérarchie n'a pas pu être remontée.
    if let Some(v) = renseigne(&q.nomenclature) {
        et(qb);
        qb.push("code3 like ").push_bind(format!("{v}%"));
    }
    if let Some(search) = q.search.as_deref().map(js::js_trim).filter(|s| !s.is_empty()) {
        let pattern = format!("%{search}%");
        et(qb);
        qb.push("(libelle1 ilike ")
            .push_bind(pattern.clone())
            .push(" or codein ilike ")
            .push_bind(pattern.clone())
            .push(" or gtin ilike ")
            .push_bind(pattern.clone())
            .push(" or reference ilike ")
            .push_bind(pattern.clone())
            .push(" or code_centrale ilike ")
            .push_bind(pattern)
            .push(")");
    }
    if !premiere {
        qb.push(")");
    }
}

/// Ligne exposée par l'API : la version de format est un détail interne.
fn vers_ligne_api(payload: Value) -> AppResult<ProductRow> {
    let mut ligne: ProductRow =
        serde_json::from_value(payload).map_err(|e| AppError::internal(format!("payload grid_rows illisible : {e}")))?;
    ligne.payload_version = None;
    Ok(ligne)
}

/// Lit les lignes de grille persistées : filtre, tri et pagination faits en SQL.
/// Ne déclenche aucun recalcul et ne contacte jamais Qlik.
pub async fn query_grid_rows(q: &GridQuery) -> AppResult<GridQueryResult> {
    let pool = db::pool()?;
    let page = q.page.unwrap_or(1).max(1);
    // `limit` absent = aucune limite : on renvoie toutes les lignes du filtre.
    let limit = q.limit.map(|l| l.max(1));

    let sort_col = q.sort.unwrap_or(GridSortKey::TotalCa).column();
    let sens = if q.order == Some(SortOrder::Asc) { "asc" } else { "desc" };

    let mut selection: QueryBuilder<Postgres> = QueryBuilder::new("select payload, computed_at from grid_rows");
    push_where(&mut selection, q);
    // Mêmes ORDER BY que drizzle (`desc(col)`, `asc(codein)`).
    selection.push(format!(" order by {sort_col} {sens}, codein asc"));
    if let Some(l) = limit {
        selection.push(" limit ").push_bind(l).push(" offset ").push_bind((page - 1) * l);
    }

    let mut comptage: QueryBuilder<Postgres> = QueryBuilder::new("select count(*)::int as total from grid_rows");
    push_where(&mut comptage, q);

    // Comptage et page en parallèle : deux connexions du pool, un seul temps d'attente.
    let (count_row, found) = tokio::try_join!(comptage.build().fetch_one(&pool), selection.build().fetch_all(&pool))?;

    let mut oldest: Option<NaiveDateTime> = None;
    let mut rows = Vec::with_capacity(found.len());
    for r in &found {
        if let Ok(Some(c)) = r.try_get::<Option<NaiveDateTime>, _>("computed_at") {
            if oldest.map(|o| c < o).unwrap_or(true) {
                oldest = Some(c);
            }
        }
        rows.push(vers_ligne_api(r.try_get("payload")?)?);
    }

    Ok(GridQueryResult { rows, total: count_row.try_get::<i32, _>("total").map(i64::from).unwrap_or(0), computed_at: oldest.map(db::iso) })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRowFound {
    pub row: ProductRow,
    pub computed_at: Option<String>,
}

/// Fiche complète d'un produit. `code_fournisseur` lève l'ambiguïté d'un article multi-fournisseurs.
pub async fn get_grid_row_by_codein(codein: &str, code_fournisseur: Option<&str>) -> AppResult<Option<GridRowFound>> {
    let pool = db::pool()?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("select payload, computed_at from grid_rows where (codein = ");
    qb.push_bind(codein.to_string());
    if let Some(f) = code_fournisseur.filter(|f| !f.is_empty()) {
        qb.push(" and code_fournisseur = ").push_bind(f.to_string());
    }
    qb.push(") order by computed_at desc limit 1");
    let Some(found) = qb.build().fetch_optional(&pool).await? else {
        return Ok(None);
    };
    let computed_at: Option<NaiveDateTime> = found.try_get("computed_at").ok().flatten();
    Ok(Some(GridRowFound { row: vers_ligne_api(found.try_get("payload")?)?, computed_at: computed_at.map(db::iso) }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSupplierRef {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
}

/// Fournisseurs chez lesquels un article figure dans l'instantané.
pub async fn list_grid_suppliers_for_codein(codein: &str) -> AppResult<Vec<GridSupplierRef>> {
    let pool = db::pool()?;
    let rows = sqlx::query("select code_fournisseur, nom_fournisseur from grid_rows where codein = $1 order by code_fournisseur asc")
        .bind(codein)
        .fetch_all(&pool)
        .await?;
    Ok(rows
        .iter()
        .map(|r| GridSupplierRef {
            code_fournisseur: r.try_get("code_fournisseur").unwrap_or_default(),
            nom_fournisseur: r.try_get("nom_fournisseur").ok().flatten(),
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GammeInstantane {
    /// Gamme courante, modifications enregistrées comprises.
    pub code_gamme: Option<String>,
    /// Gamme serveur au moment du calcul de la grille.
    pub code_gamme_init: Option<String>,
    pub nom_fournisseur: Option<String>,
}

/// Gammes d'articles d'un fournisseur dans l'instantané. Un codein absent de la
/// carte n'appartient pas à ce fournisseur (ou n'a pas encore été calculé).
pub async fn get_grid_rows_gammes(code_fournisseur: &str, codeins: &[String]) -> AppResult<HashMap<String, GammeInstantane>> {
    let mut out = HashMap::new();
    if codeins.is_empty() {
        return Ok(out);
    }
    let pool = db::pool()?;
    for lot in codeins.chunks(CHUNK_CODEINS) {
        let found = sqlx::query(
            "select codein, code_gamme, code_gamme_init, nom_fournisseur from grid_rows \
             where code_fournisseur = $1 and codein = any($2)",
        )
        .bind(code_fournisseur)
        .bind(lot)
        .fetch_all(&pool)
        .await?;
        for r in &found {
            out.insert(
                r.try_get::<String, _>("codein").unwrap_or_default(),
                GammeInstantane {
                    code_gamme: r.try_get("code_gamme").ok().flatten(),
                    code_gamme_init: r.try_get("code_gamme_init").ok().flatten(),
                    nom_fournisseur: r.try_get("nom_fournisseur").ok().flatten(),
                },
            );
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFreshness {
    pub row_count: i64,
    pub computed_at: Option<String>,
}

/// Indique si un fournisseur a déjà été calculé au moins une fois.
/// Sert à répondre `202 not_ready` plutôt que de déclencher un calcul long.
pub async fn get_grid_freshness(code_fournisseur: &str) -> AppResult<Option<GridFreshness>> {
    let pool = db::pool()?;
    let found =
        sqlx::query("select count(*)::int as row_count, max(computed_at) as computed_at from grid_rows where code_fournisseur = $1")
            .bind(code_fournisseur)
            .fetch_one(&pool)
            .await?;
    let row_count = found.try_get::<i32, _>("row_count").map(i64::from).unwrap_or(0);
    if row_count == 0 {
        return Ok(None);
    }
    let computed_at: Option<NaiveDateTime> = found.try_get("computed_at").ok().flatten();
    Ok(Some(GridFreshness { row_count, computed_at: computed_at.map(db::iso) }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSupplier {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub row_count: i64,
    pub computed_at: Option<String>,
}

/// Fournisseurs présents dans l'instantané, avec leur fraîcheur.
pub async fn list_grid_suppliers() -> AppResult<Vec<GridSupplier>> {
    let pool = db::pool()?;
    let found = sqlx::query(
        "select code_fournisseur, max(nom_fournisseur) as nom_fournisseur, count(*)::int as row_count, \
         max(computed_at) as computed_at from grid_rows group by code_fournisseur order by code_fournisseur asc",
    )
    .fetch_all(&pool)
    .await?;
    Ok(found
        .iter()
        .map(|r| GridSupplier {
            code_fournisseur: r.try_get("code_fournisseur").unwrap_or_default(),
            nom_fournisseur: r.try_get("nom_fournisseur").ok().flatten(),
            row_count: r.try_get::<i32, _>("row_count").map(i64::from).unwrap_or(0),
            computed_at: r.try_get::<Option<NaiveDateTime>, _>("computed_at").ok().flatten().map(db::iso),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Inventaire des nomenclatures d'un fournisseur
// ---------------------------------------------------------------------------

/// Un poste de nomenclature, avec son poids — de quoi décider par où découper.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridNomenclature {
    pub code: String,
    /// Libellé du poste, lu dans le payload (il n'a pas de colonne dédiée).
    pub libelle: Option<String>,
    pub nb_articles: i64,
    #[serde(serialize_with = "js::num::serialize")]
    pub total_ca: f64,
    #[serde(serialize_with = "js::num::serialize")]
    pub total_quantite: f64,
}

/// Longueur du code pour chaque niveau : « 32 » → « 3202 » → « 320211 ».
pub const NOMENCLATURE_LONGUEURS: [(u8, i32); 3] = [(1, 2), (2, 4), (3, 6)];

/// Longueur du code d'un niveau (1, 2 ou 3).
pub fn nomenclature_longueur(niveau: u8) -> i32 {
    NOMENCLATURE_LONGUEURS.iter().find(|(n, _)| *n == niveau).map(|(_, l)| *l).unwrap_or(2)
}

/// Répartition des articles d'un fournisseur par niveau de nomenclature.
///
/// Sans cela, un appelant qui veut découper un gros fournisseur par nomenclature
/// est coincé : le filtre existe sur `/grid`, mais rien ne lui dit **quelles**
/// valeurs existent — il devrait tout télécharger pour les découvrir, ce qui
/// annule le bénéfice du découpage.
///
/// Les niveaux sont dérivés par **préfixe de `code3`** (codes hiérarchiques à 6
/// chiffres, de 31xxxx à 40xxxx), et non des colonnes `code1`/`code2`. Celles-ci
/// ne sont renseignées que si `pgGetNomenclatureByFournisseur` a su remonter la
/// hiérarchie ; quand elle échoue, seul `code3` est rempli. Le préfixe, lui, est
/// toujours disponible.
///
/// Tout est agrégé en SQL : la réponse fait quelques dizaines de lignes, même pour
/// un fournisseur de 130 000 articles.
///
/// Écart volontaire avec le TS : drizzle répétait `left(code3, $n)` dans le
/// GROUP BY avec un **autre** paramètre, ce que PostgreSQL refuse (« must appear
/// in the GROUP BY clause ») — la requête échouait systématiquement. On groupe
/// ici par position (`group by 1`), même résultat attendu.
pub async fn list_grid_nomenclatures(code_fournisseur: &str, niveau: u8, parent: Option<&str>) -> AppResult<Vec<GridNomenclature>> {
    let pool = db::pool()?;
    let longueur = nomenclature_longueur(niveau);
    // Les libellés n'ont pas de colonne dédiée : on les lit dans le payload.
    // Aux niveaux 1 et 2 ils peuvent être absents (même cause que ci-dessus) ;
    // le code et les compteurs, eux, restent justes.
    let libelle_key = match niveau {
        1 => "libelleNiveau1",
        2 => "libelleNiveau2",
        _ => "libelle3",
    };

    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("select left(code3, ");
    qb.push_bind(longueur)
        .push(") as code, max(payload ->> ")
        .push_bind(libelle_key)
        .push(") as libelle, count(*)::int as nb_articles, coalesce(sum(total_ca), 0)::float as total_ca, ")
        .push("coalesce(sum(total_quantite), 0)::float as total_quantite from grid_rows where (code_fournisseur = ")
        .push_bind(code_fournisseur.to_string())
        .push(" and code3 is not null and length(code3) >= ")
        .push_bind(longueur);
    // `parent` est lui aussi un préfixe : « 32 » pour descendre au niveau 2.
    if let Some(p) = parent.filter(|p| !p.is_empty()) {
        qb.push(" and code3 like ").push_bind(format!("{p}%"));
    }
    qb.push(") group by 1 order by coalesce(sum(total_ca), 0) desc");

    let rows = qb.build().fetch_all(&pool).await?;
    Ok(rows
        .iter()
        .map(|r| GridNomenclature {
            code: db::string_or_empty(r, "code"),
            libelle: r.try_get("libelle").ok().flatten(),
            nb_articles: db::f64_or0(r, "nb_articles") as i64,
            total_ca: db::f64_or0(r, "total_ca"),
            total_quantite: db::f64_or0(r, "total_quantite"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liste_blanche_du_tri() {
        assert_eq!(GRID_SORT_KEYS.len(), SORTABLE.len());
        for (i, (_, k, _)) in SORTABLE.iter().enumerate() {
            assert_eq!(GRID_SORT_KEYS[i], *k);
            assert_eq!(GridSortKey::from_key(k).unwrap().as_str(), *k);
        }
        assert_eq!(GridSortKey::from_key("total_ca; drop table x"), None);
        assert_eq!(GridSortKey::TotalCa.column(), "total_ca");
    }

    #[test]
    fn clause_where() {
        let q = GridQuery {
            code_fournisseur: Some("F1".into()),
            gamme: Some(String::new()),
            nomenclature: Some("32".into()),
            search: Some("  bougie ".into()),
            ..Default::default()
        };
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("select 1 from grid_rows");
        push_where(&mut qb, &q);
        assert_eq!(
            qb.sql(),
            "select 1 from grid_rows where (code_fournisseur = $1 and code3 like $2 and (libelle1 ilike $3 or codein ilike $4 or gtin ilike $5 or reference ilike $6 or code_centrale ilike $7))"
        );
        let mut vide: QueryBuilder<Postgres> = QueryBuilder::new("select 1 from grid_rows");
        push_where(&mut vide, &GridQuery::default());
        assert_eq!(vide.sql(), "select 1 from grid_rows");
    }

    #[test]
    fn longueurs_de_nomenclature() {
        assert_eq!(nomenclature_longueur(1), 2);
        assert_eq!(nomenclature_longueur(2), 4);
        assert_eq!(nomenclature_longueur(3), 6);
    }
}
