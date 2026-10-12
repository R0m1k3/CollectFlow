//! CollectFlow — Client PostgreSQL FF Nancy (port de `src/lib/pg-ff-client.ts`).
//!
//! Remplace les appels HTTP per-article vers api.ffnancy.fr par des requêtes
//! SQL bulk directes sur la base PostgreSQL FF Nancy.
//!
//! Chaque fonction fait 1 seule requête filtrée par codefou — O(1) au lieu de O(N).
//!
//! Le pilote Node rendait les `numeric`/`bigint` en chaînes : toutes les colonnes
//! sont lues ici de façon tolérante (`db::get_f64`, `db::get_string`), quel que
//! soit leur type SQL réel dans la recopie FF.

use super::api::{ff_get, get_ff_api_base, status_text};
use super::js::{coalesce, encode, get, js_number, js_number_or0, js_string, message_erreur, truthy};
use crate::db::{get_f64, get_string, pool, rows_to_json, string_or_empty};
use crate::error::short;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, Utc};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, QueryBuilder, Row, TypeInfo, ValueRef};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;
use tokio::sync::OnceCell;

// ---------------------------------------------------------------------------
// Lecture tolérante des colonnes
// ---------------------------------------------------------------------------

/// `String(r.col ?? "")`.
fn s(row: &PgRow, col: &str) -> String {
    string_or_empty(row, col)
}

/// Texte ou `null`.
fn os(row: &PgRow, col: &str) -> Option<String> {
    get_string(row, col)
}

/// `Number(r.col) || 0`.
fn f(row: &PgRow, col: &str) -> f64 {
    get_f64(row, col).unwrap_or(0.0)
}

/// Nombre ou `null`.
fn of(row: &PgRow, col: &str) -> Option<f64> {
    get_f64(row, col)
}

/// Entier ou `null`.
fn oi(row: &PgRow, col: &str) -> Option<i64> {
    get_f64(row, col).map(|v| v as i64)
}

/// Booléen ou `null` (accepte aussi un entier 0/1).
fn ob(row: &PgRow, col: &str) -> Option<bool> {
    match row.try_get::<Option<bool>, _>(col) {
        Ok(v) => v,
        Err(_) => get_f64(row, col).map(|v| v != 0.0),
    }
}

/// `parLots` : `f` sur chaque élément, au plus `simultanes` à la fois,
/// résultats dans l'ordre. Évite de lancer des centaines d'appels à l'API FF
/// d'un coup, qui la saturent et finissent en délais dépassés.
async fn par_lots<T, R, F, Fut>(items: Vec<T>, simultanes: usize, f: F) -> Vec<R>
where
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    futures::stream::iter(items.into_iter().map(f)).buffered(simultanes.max(1)).collect().await
}

// ---------------------------------------------------------------------------
// Types résultats SQL
// ---------------------------------------------------------------------------

/// Paire `{ code, nom }` (fournisseurs, magasins).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct CodeNom {
    pub code: String,
    pub nom: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgArticle {
    pub no_id: i64,
    pub codein: String,
    /// Code centrale = articles.artcentrale (format 10000XXXXXX) — clé jointure Qlik « Article Code ».
    /// Vide pour les articles non référencés centralement.
    #[serde(rename = "codeCentrale", skip_serializing_if = "Option::is_none")]
    pub code_centrale: Option<String>,
    pub codefou: String,
    pub nomfou: Option<String>,
    pub libelle1: Option<String>,
    pub pcb: Option<f64>,
    pub reference: Option<String>,
    pub ean13: Option<String>,
    /// art_gtin.gtin (préférentiel)
    pub gtin: Option<String>,
    /// article_infosup.prix_vente_mini
    pub pv_central: Option<f64>,
    /// cube_pa.pa
    pub pa: Option<f64>,
    /// artfou1.code où preference=1
    pub codefou_principal: Option<String>,
    /// nom du fournisseur principal
    pub nomfou_principal: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgMensuelRow {
    pub codein: String,
    pub site: String,
    /// "YYYY-MM"
    pub mois: String,
    pub qte_vendue: f64,
    /// mntmvtttc (à vérifier si HT ou TTC)
    pub ca_ht: f64,
    pub marge: f64,
    /// qtestock du dernier mouvement du mois
    pub stock_fin_mois: Option<f64>,
    pub qte_recue: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgStockRow {
    pub codein: String,
    pub site: String,
    pub stockdispo: Option<f64>,
    pub qte: Option<f64>,
    pub valstock: Option<f64>,
    pub prmp: Option<f64>,
    /// Prix de vente du site — cube_stock.pv, filet de secours si cube_pv est vide.
    pub pv: Option<f64>,
    pub dernierevente: Option<String>,
    pub dernierereception: Option<String>,
}

// ---------------------------------------------------------------------------
// 0. Liste des fournisseurs
// ---------------------------------------------------------------------------

/// Retourne la liste des fournisseurs depuis fouident (vrais noms) + artfou1.
/// Liste vide en cas d'erreur.
pub async fn pg_get_fournisseurs(search: Option<&str>) -> Vec<CodeNom> {
    let res = async {
        let mut qb = QueryBuilder::<Postgres>::new(
            "
            SELECT DISTINCT fi.code, fi.nom
            FROM fouident fi
            INNER JOIN artfou1 af ON af.code = fi.code
            WHERE fi.nom IS NOT NULL
              AND fi.nom != ''
              ",
        );
        if let Some(search) = search.filter(|s| !s.is_empty()) {
            qb.push("AND (fi.nom ILIKE ")
                .push_bind(format!("%{search}%"))
                .push(" OR fi.code ILIKE ")
                .push_bind(format!("%{search}%"))
                .push(")");
        }
        qb.push(
            "
            ORDER BY fi.nom
        ",
        );
        let rows = qb.build().fetch_all(&pool()?).await?;
        anyhow::Ok(
            rows.iter()
                .map(|r| CodeNom { code: s(r, "code"), nom: s(r, "nom") })
                .filter(|r| !r.code.is_empty() && !r.nom.is_empty())
                .collect(),
        )
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetFournisseurs error: {}", short(&e, 200));
            vec![]
        }
    }
}

// ---------------------------------------------------------------------------
// 1. Articles du fournisseur
// ---------------------------------------------------------------------------

/// Tous les articles d'un fournisseur avec leurs métadonnées (une requête).
/// 1 seule requête SQL — remplace getArticlesByFournisseur() + per-article fetches.
/// Erreur SQL propagée.
pub async fn pg_get_articles_by_fournisseur(codefou: &str) -> anyhow::Result<Vec<PgArticle>> {
    // DISTINCT ON (a.no_id) car artfou1 peut avoir plusieurs lignes par article/fournisseur.
    // Pas de filtre "actif" : on retourne tous les articles pour ne pas exclure les articles
    // d'une session précédente (snapshot) qui n'ont pas de gamme DB ni de ventes récentes.
    // Le filtrage gamme-Y sans ventes est fait en aval dans getProductRows (Phase 10).
    // afpref : fournisseur préférentiel (preference=1) de l'article — peut différer du fournisseur consulté.
    let rows = sqlx::query(
        r#"
        SELECT DISTINCT ON (a.no_id)
            a.no_id,
            a.codein,
            a.artcentrale               AS "codeCentrale",
            af.code                     AS codefou,
            fi.nom                      AS nomfou,
            a.libelle1,
            af.pcb,
            af.reference,
            af.ean13,
            COALESCE(ag.gtin, af.ean13) AS gtin,
            ai.prix_vente_mini          AS pv_central,
            pa.pa,
            last_fournisseur.codefou_dernier AS codefou_principal,
            last_fournisseur.nomfou_dernier  AS nomfou_principal
        FROM artfou1 af
        JOIN articles a ON a.no_id = af.art_no_id
        LEFT JOIN fouident fi ON fi.code = af.code
        LEFT JOIN article_infosup ai ON ai.artnoid = a.no_id
        LEFT JOIN cube_pa pa ON pa.artnoid = a.no_id
        LEFT JOIN art_gtin ag ON ag.idarticle = a.no_id AND ag.preferentiel = 1
        LEFT JOIN LATERAL (
            SELECT af2.code AS codefou_dernier, fi2.nom AS nomfou_dernier
            FROM artfou1 af2
            LEFT JOIN fouident fi2 ON fi2.code = af2.code
            WHERE af2.art_no_id = a.no_id
            ORDER BY af2.no_id DESC
            LIMIT 1
        ) last_fournisseur ON true
        WHERE af.code = $1
          AND a.codein IS NOT NULL
          AND (af.suspendu IS NULL OR af.suspendu::text NOT IN ('1', 'true', 't', 'yes', 'y', 'on'))
          AND (a.suspendu IS NULL OR a.suspendu::text NOT IN ('1', 'true', 't', 'yes', 'y', 'on'))
        ORDER BY a.no_id, af.no_id
    "#,
    )
    .bind(codefou)
    .fetch_all(&pool()?)
    .await?;

    tracing::info!("[pg-ff] Articles: {} pour {codefou}", rows.len());
    Ok(rows
        .iter()
        .map(|r| PgArticle {
            no_id: oi(r, "no_id").unwrap_or(0),
            codein: s(r, "codein"),
            code_centrale: os(r, "codeCentrale"),
            codefou: s(r, "codefou"),
            nomfou: os(r, "nomfou"),
            libelle1: os(r, "libelle1"),
            pcb: of(r, "pcb"),
            reference: os(r, "reference"),
            ean13: os(r, "ean13"),
            gtin: os(r, "gtin"),
            pv_central: of(r, "pv_central"),
            pa: of(r, "pa"),
            codefou_principal: os(r, "codefou_principal"),
            nomfou_principal: os(r, "nomfou_principal"),
        })
        .filter(|a| !a.codein.is_empty())
        .collect())
}

// ---------------------------------------------------------------------------
// 2. Données mensuelles (ventes + stock + réceptions)
// ---------------------------------------------------------------------------

fn mensuel_row(r: &PgRow) -> PgMensuelRow {
    PgMensuelRow {
        codein: s(r, "codein"),
        site: s(r, "site"),
        mois: s(r, "mois"),
        qte_vendue: f(r, "qte_vendue"),
        ca_ht: f(r, "ca_ht"),
        marge: f(r, "marge"),
        stock_fin_mois: of(r, "stock_fin_mois"),
        qte_recue: f(r, "qte_recue"),
    }
}

/// Retourne les données mensuelles agrégées par (codein, site, mois).
/// 1 seule requête SQL — remplace getMensuelByArticles() (N appels HTTP).
///
/// genremvt = 3  → ventes clients
/// genremvt 1/2  → réceptions (à confirmer selon nomenclature FF Nancy)
/// qtestock      → stock après mouvement (MAX du mois ≈ stock fin de mois)
pub async fn pg_get_mensuel_by_fournisseur(codefou: &str, date_debut: &str, date_fin: &str) -> anyhow::Result<Vec<PgMensuelRow>> {
    // IMPORTANT : utiliser DISTINCT sur artfou1 pour éviter les doublons de mouvements.
    // Un article peut avoir plusieurs lignes artfou1 pour le même fournisseur (pcb/ref différents),
    // ce qui multiplierait chaque mouvement et gonflerait les totaux.
    //
    // stock_fin_mois = qtestock du DERNIER mouvement du mois (tri par datmvt DESC).
    // MAX(qtestock) donnait le stock de début de mois (avant les premières ventes), ce qui était faux.
    let rows = sqlx::query(
        r#"
        WITH base AS (
            SELECT
                a.codein,
                m.site,
                TO_CHAR(m.datmvt, 'YYYY-MM')  AS mois,
                m.qtemvt,
                m.mntmvtttc,
                m.margemvt,
                m.genremvt,
                m.qtestock,
                ROW_NUMBER() OVER (
                    PARTITION BY a.codein, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
                    ORDER BY m.datmvt DESC
                ) AS rn_last
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = $1) af
                ON af.art_no_id = a.no_id
            WHERE m.datmvt BETWEEN $2::date AND $3::date
              AND m.site IN ('292', '579')
        )
        SELECT
            codein,
            site,
            mois,
            SUM(CASE WHEN genremvt = 3 THEN -qtemvt    ELSE 0 END)::float           AS qte_vendue,
            SUM(CASE WHEN genremvt = 3 THEN -mntmvtttc ELSE 0 END)::float           AS ca_ht,
            SUM(CASE WHEN genremvt = 3 THEN  margemvt  ELSE 0 END)::float           AS marge,
            MAX(CASE WHEN rn_last = 1 THEN qtestock ELSE NULL END)::float            AS stock_fin_mois,
            SUM(CASE WHEN genremvt IN (1, 2) THEN  qtemvt ELSE 0 END)::float        AS qte_recue
        FROM base
        GROUP BY codein, site, mois
        ORDER BY codein, site, mois
    "#,
    )
    .bind(codefou)
    .bind(date_debut)
    .bind(date_fin)
    .fetch_all(&pool()?)
    .await?;

    Ok(rows.iter().map(mensuel_row).collect())
}

// ---------------------------------------------------------------------------
// 3. Gammes (saison active)
// ---------------------------------------------------------------------------

/// Retourne la gamme courante (saison active) pour chaque article du fournisseur.
/// 1 requête SQL — remplace getReferentielByArticles() pour la partie gammes.
pub async fn pg_get_gammes_by_fournisseur(codefou: &str) -> anyhow::Result<HashMap<String, String>> {
    // DISTINCT ON (codein) → 1 gamme par article, saison la plus récente en premier
    // saisons n'a PAS de colonne "actif" → pas de filtre actif
    let rows = sqlx::query(
        r#"
        SELECT DISTINCT ON (a.codein)
            a.codein,
            g.code AS gamme_code
        FROM art_gamme_saison ags
        JOIN articles a  ON a.no_id = ags.artnoid
        JOIN artfou1 af  ON af.art_no_id = a.no_id AND af.code = $1
        JOIN gammes g    ON g.no_id = ags.idgamme
        JOIN saisons s   ON s.no_id = ags.idsaison
        ORDER BY a.codein, s.no_id DESC
    "#,
    )
    .bind(codefou)
    .fetch_all(&pool()?)
    .await?;

    let mut map = HashMap::new();
    for r in &rows {
        let codein = s(r, "codein");
        let gamme = s(r, "gamme_code");
        if !codein.is_empty() && !gamme.is_empty() {
            map.insert(codein, gamme.trim().to_string());
        }
    }
    Ok(map)
}

/// Gammes **serveur** pour une liste de codein, tous fournisseurs confondus.
///
/// Variante de `pg_get_gammes_by_fournisseur` sans la jointure `artfou1` : la recherche
/// de l'API `/api/v1` est transversale, on ne connaît donc pas le fournisseur.
/// C'est la gamme telle qu'elle existe en base — non modifiée, indépendante des
/// snapshots de session qui peuvent surcharger `codeGamme` dans la Grille.
pub async fn pg_get_gammes_by_codeins(codeins: &[String]) -> anyhow::Result<HashMap<String, String>> {
    let mut seen = HashSet::new();
    let unique: Vec<String> =
        codeins.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty() && seen.insert(c.clone())).collect();
    if unique.is_empty() {
        return Ok(HashMap::new());
    }

    // Découpage obligatoire : chaque codein devient un paramètre lié, or PostgreSQL
    // en accepte 65535 au maximum. Un gros fournisseur dépasse 130 000 articles —
    // la requête échouait alors purement et simplement.
    const CHUNK: usize = 2000;
    let mut map = HashMap::new();
    let pool = pool()?;

    for batch in unique.chunks(CHUNK) {
        // DISTINCT ON (codein) → 1 gamme par article, saison la plus récente en premier.
        let mut qb = QueryBuilder::<Postgres>::new(
            "
            SELECT DISTINCT ON (a.codein)
                TRIM(a.codein::text) AS codein,
                g.code AS gamme_code
            FROM art_gamme_saison ags
            JOIN articles a ON a.no_id = ags.artnoid
            JOIN gammes g   ON g.no_id = ags.idgamme
            JOIN saisons s  ON s.no_id = ags.idsaison
            WHERE TRIM(a.codein::text) IN (",
        );
        let mut sep = qb.separated(", ");
        for c in batch {
            sep.push_bind(c.clone());
        }
        qb.push(
            ")
            ORDER BY a.codein, s.no_id DESC
        ",
        );
        let rows = qb.build().fetch_all(&pool).await?;
        for r in &rows {
            let codein = s(r, "codein");
            let gamme = s(r, "gamme_code");
            if !codein.is_empty() && !gamme.is_empty() {
                map.insert(codein, gamme.trim().to_string());
            }
        }
    }
    tracing::info!("[pg-ff] pgGetGammesByCodeins: {}/{} articles avec gamme", map.len(), unique.len());
    Ok(map)
}

// ---------------------------------------------------------------------------
// 4. Nomenclature (famille / sous-famille)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgNomRow {
    pub codein: String,
    /// code feuille (ex: "360504")
    pub code3: String,
    /// libellé feuille
    pub libelle3: String,
    /// famille (4 chiffres)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub libelle2: Option<String>,
    /// secteur (2 chiffres)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code1: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub libelle1nom: Option<String>,
}

/// Cache process : colonne « parent » de `nomenclature` (`None` = aucune).
/// Une erreur de lecture n'est pas mémorisée (nouvel essai au prochain appel).
static NOMENCLATURE_PARENT_COL: OnceCell<Option<String>> = OnceCell::const_new();

/// Découvre (une seule fois par process) le nom de la colonne "parent" de la
/// table `nomenclature`, qui porte la FK vers le `no_id` du niveau supérieur.
///
/// On ne peut pas la coder en dur : le nom varie selon les installations
/// ("chemin_pere" existe mais c'est un chemin *texte* matérialisé, pas la FK),
/// d'où le filtre explicite sur `data_type` entier.
async fn get_nomenclature_parent_col() -> anyhow::Result<Option<String>> {
    NOMENCLATURE_PARENT_COL
        .get_or_try_init(|| async {
            let rows = sqlx::query(
                r#"
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'nomenclature' ORDER BY ordinal_position
    "#,
            )
            .fetch_all(&pool()?)
            .await?;
            let nom_cols: Vec<(String, String)> = rows.iter().map(|r| (s(r, "column_name"), s(r, "data_type"))).collect();
            tracing::info!(
                "[pg-ff] Nomenclature colonnes: {}",
                nom_cols.iter().map(|(c, t)| format!("{c}({t})")).collect::<Vec<_>>().join(", ")
            );
            // Cherche une colonne "parent" qui soit un entier (FK vers no_id du parent)
            // "chemin_pere" = chemin vers le père en français
            // On vérifie le data_type : integer/bigint/smallint uniquement (pas text/varchar qui serait un chemin matérialisé)
            static RE_PARENT: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)parent|pere|father").unwrap());
            static RE_NOID: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)no_id$").unwrap());
            static RE_INT: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)int|serial").unwrap());
            let parent = nom_cols
                .iter()
                .find(|(c, t)| (RE_PARENT.is_match(c) || (c != "no_id" && RE_NOID.is_match(c))) && RE_INT.is_match(t))
                .map(|(c, _)| c.clone());
            tracing::info!("[pg-ff] Nomenclature parentCol: {}", parent.as_deref().unwrap_or("null"));
            anyhow::Ok(parent)
        })
        .await
        .cloned()
}

/// Identifiant SQL entre guillemets (nom issu d'information_schema).
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Retourne la nomenclature (famille/sous-famille) pour chaque article du fournisseur.
/// FK confirmée : articles.nom_no_id → nomenclature.no_id
/// Colonnes confirmées : nomenclature.code, nomenclature.libelle
/// Colonne parent : découverte dynamiquement via information_schema
pub async fn pg_get_nomenclature_by_fournisseur(codefou: &str) -> anyhow::Result<HashMap<String, PgNomRow>> {
    let parent_col = get_nomenclature_parent_col().await?;

    let rows = if let Some(pc) = parent_col.as_deref() {
        let pc = quote_ident(pc);
        let sql = format!(
            r#"
            SELECT
                a.codein,
                n3.code       AS code3,
                n3.libelle    AS libelle3,
                n2.code       AS code2,
                n2.libelle    AS libelle2,
                n1.code       AS code1,
                n1.libelle    AS libelle1nom
            FROM artfou1 af
            JOIN articles a      ON a.no_id = af.art_no_id AND af.code = $1
            JOIN nomenclature n3 ON n3.no_id = a.nom_no_id
            LEFT JOIN nomenclature n2 ON n2.no_id = n3.{pc}
            LEFT JOIN nomenclature n1 ON n1.no_id = n2.{pc}
            WHERE a.codein IS NOT NULL
        "#
        );
        sqlx::query(&sql).bind(codefou).fetch_all(&pool()?).await?
    } else {
        // Sans hiérarchie : juste le niveau feuille
        sqlx::query(
            r#"
            SELECT
                a.codein,
                n3.code       AS code3,
                n3.libelle    AS libelle3
            FROM artfou1 af
            JOIN articles a      ON a.no_id = af.art_no_id AND af.code = $1
            JOIN nomenclature n3 ON n3.no_id = a.nom_no_id
            WHERE a.codein IS NOT NULL
        "#,
        )
        .bind(codefou)
        .fetch_all(&pool()?)
        .await?
    };

    tracing::info!("[pg-ff] Nomenclature: {} articles, parentCol=\"{}\"", rows.len(), parent_col.as_deref().unwrap_or("none"));
    let mut map = HashMap::new();
    for r in &rows {
        let row = PgNomRow {
            codein: s(r, "codein"),
            code3: s(r, "code3"),
            libelle3: s(r, "libelle3"),
            code2: os(r, "code2"),
            libelle2: os(r, "libelle2"),
            code1: os(r, "code1"),
            libelle1nom: os(r, "libelle1nom"),
        };
        if !row.codein.is_empty() {
            map.insert(row.codein.clone(), row);
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// 5. Stock temps réel (cube_stock)
// ---------------------------------------------------------------------------

/// Retourne le stock actuel par site pour chaque article du fournisseur.
/// 1 requête SQL — remplace la partie stock du référentiel.
pub async fn pg_get_stock_by_fournisseur(codefou: &str) -> anyhow::Result<HashMap<String, Vec<PgStockRow>>> {
    // `site` est élagué pour la même raison que dans pg_get_prix_vente_by_fournisseur :
    // il sert de clé de recherche (derniereLivraisonByStore, prix de repli).
    let rows = sqlx::query(
        r#"
        SELECT
            a.codein,
            TRIM(cs.site::text) AS site,
            cs.stockdispo::float,
            cs.qte::float,
            cs.valstock::float,
            cs.prmp::float,
            cs.pv::float,
            cs.dernierevente::text,
            cs.dernierereception::text
        FROM cube_stock cs
        JOIN articles a ON a.no_id = cs.artnoid
        JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = $1) af
            ON af.art_no_id = a.no_id
    "#,
    )
    .bind(codefou)
    .fetch_all(&pool()?)
    .await?;

    let mut map: HashMap<String, Vec<PgStockRow>> = HashMap::new();
    for r in &rows {
        let row = PgStockRow {
            codein: s(r, "codein"),
            site: s(r, "site"),
            stockdispo: of(r, "stockdispo"),
            qte: of(r, "qte"),
            valstock: of(r, "valstock"),
            prmp: of(r, "prmp"),
            pv: of(r, "pv"),
            dernierevente: os(r, "dernierevente"),
            dernierereception: os(r, "dernierereception"),
        };
        map.entry(row.codein.clone()).or_default().push(row);
    }
    Ok(map)
}

/// Prix de vente par article et par site (`cube_pv`).
///
/// Pendant exact de `cube_pa` pour l'achat, rafraîchi chaque nuit depuis le cube
/// MSSQL `Cube_PV`. C'est LA source du prix de vente : `article_infosup`, seule
/// table lue jusqu'ici pour cette information, ne porte qu'un prix plancher de
/// paramétrage (`prix_vente_mini`) qui reste vide en pratique.
///
/// Retour : codein → { site → PV }. Les prix nuls sont écartés — un article non
/// tarifé n'est pas un article à 0 €.
pub async fn pg_get_prix_vente_by_fournisseur(codefou: &str) -> anyhow::Result<HashMap<String, BTreeMap<String, f64>>> {
    // Le site sert de CLÉ de recherche côté Grille (prixVenteByStore["292"]), d'où
    // l'élagage : la synchronisation Apiflow écrit `cube_pv.site` brut, sans passer
    // par le `safeStr` qu'elle applique à `cube_stock`. Une colonne MSSQL de largeur
    // fixe remonterait complétée d'espaces, et la recherche échouerait en silence —
    // le prix resterait visible en « tous magasins » et vide magasin par magasin.
    let rows = sqlx::query(
        r#"
        SELECT
            a.codein,
            TRIM(cpv.site::text) AS site,
            cpv.pv::float AS pv
        FROM cube_pv cpv
        JOIN articles a ON a.no_id = cpv.artnoid
        JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = $1) af
            ON af.art_no_id = a.no_id
        WHERE cpv.pv IS NOT NULL AND cpv.pv > 0
    "#,
    )
    .bind(codefou)
    .fetch_all(&pool()?)
    .await?;

    let mut map: HashMap<String, BTreeMap<String, f64>> = HashMap::new();
    for r in &rows {
        let codein = s(r, "codein");
        let site = s(r, "site");
        if codein.is_empty() || site.is_empty() {
            continue;
        }
        map.entry(codein).or_default().insert(site, of(r, "pv").unwrap_or(f64::NAN));
    }
    tracing::info!("[pg-ff] Prix de vente : {} articles tarifés pour {codefou}", map.len());
    Ok(map)
}

// ---------------------------------------------------------------------------
// 6. Commandes en cours
// ---------------------------------------------------------------------------

/// Retourne les quantités commandées en cours pour chaque article du fournisseur.
/// 1 requête SQL — remplace getCommandesByFournisseur().
pub async fn pg_get_commandes_by_fournisseur(codefou: &str) -> anyhow::Result<HashMap<String, f64>> {
    // cdefou_vivant est une vue dénormalisée : articles_codein et cdefou_ligne_qtecde disponibles directement
    let rows = sqlx::query(
        r#"
        SELECT
            cv.articles_codein              AS codein,
            SUM(cv.cdefou_ligne_qtecde)::float AS qtecde
        FROM cdefou_vivant cv
        JOIN artfou1 af ON af.no_id = cv.artfou1_no_id AND af.code = $1
        WHERE cv.articles_codein IS NOT NULL
        GROUP BY cv.articles_codein
    "#,
    )
    .bind(codefou)
    .fetch_all(&pool()?)
    .await?;

    let mut map = HashMap::new();
    for r in &rows {
        let codein = s(r, "codein");
        if !codein.is_empty() {
            map.insert(codein, f(r, "qtecde"));
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// 7. Dashboard quotidien (hit parade + évolution N/N-1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct DashboardSiteStats {
    pub site: String,
    pub ca_hier: f64,
    pub ca_n1: f64,
    pub tickets_hier: f64,
    pub tickets_n1: f64,
    pub qte_hier: f64,
    pub marge_hier: f64,
    pub lignes_hier: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DashboardTopItem {
    pub codein: String,
    pub libelle1: String,
    pub ca: f64,
    pub qte: f64,
    pub marge: f64,
    pub stock: f64,
    pub fournisseur: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DashboardSiteTop10 {
    pub site: String,
    pub ca: Vec<DashboardTopItem>,
    pub qte: Vec<DashboardTopItem>,
    pub marge: Vec<DashboardTopItem>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub date_hier: String,
    #[serde(rename = "dateN1")]
    pub date_n1: String,
    pub sites: Vec<DashboardSiteStats>,
    #[serde(rename = "top10BySite")]
    pub top10_by_site: Vec<DashboardSiteTop10>,
}

/// Éléments d'un tableau de la réponse (`x ?? []`).
fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    match get(v, key) {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

/// Chaîne d'un champ texte (`null`/absent → vide).
fn str_field(v: &Value, key: &str) -> String {
    match get(v, key) {
        None | Some(Value::Null) => String::new(),
        Some(x) => js_string(x),
    }
}

#[derive(Default, Clone, Copy)]
struct StockSites {
    stock292: f64,
    stock579: f64,
    stock_total: f64,
}

/// Enrichissement d'un article du dashboard : stock (référentiel) et
/// fournisseur réel (dernière entrée, sinon référentiel). Comme dans le TS, ce
/// qui a été lu avant une erreur reste acquis (le stock est enregistré avant la
/// lecture de `/dernier-fournisseur`).
#[derive(Default)]
struct EnrichissementDashboard {
    stock: Option<StockSites>,
    fournisseur: Option<String>,
}

async fn enrichir_article_dashboard(base: &str, codein: &str, out: &mut EnrichissementDashboard) -> anyhow::Result<()> {
    let art_res = ff_get(&format!("{base}/api/articles?codein={}", encode(codein))).await?;
    if !art_res.status().is_success() {
        return Ok(());
    }
    let art_data: Value = art_res.json().await?;
    let first = match get(&art_data, "articles") {
        Some(Value::Array(a)) if !a.is_empty() => a[0].clone(),
        _ => return Ok(()),
    };
    let no_id = match get(&first, "no_id") {
        Some(v) if truthy(v) => js_string(v),
        _ => return Ok(()),
    };

    let url_ref = format!("{base}/api/articles/{}/referentiel", encode(&no_id));
    let url_dernier = format!("{base}/api/articles/{}/dernier-fournisseur", encode(&no_id));
    let (ref_res, dernier_res) = tokio::join!(ff_get(&url_ref), ff_get(&url_dernier));
    let ref_res = ref_res?;
    let dernier_res = dernier_res?;

    // Stock (toujours depuis referentiel)
    let mut ref_fournisseur_fallback = String::new();
    if ref_res.status().is_success() {
        let ref_data: Value = ref_res.json().await?;
        let mut st = StockSites::default();
        if let Some(Value::Array(lignes)) = get(&ref_data, "stock") {
            for l in lignes {
                let qte = js_number_or0(get(l, "qte").unwrap_or(&Value::Null));
                match get(l, "site").and_then(|v| v.as_str()) {
                    Some("292") => st.stock292 += qte,
                    Some("579") => st.stock579 += qte,
                    _ => {}
                }
                st.stock_total += qte;
            }
        }
        out.stock = Some(st);

        // Fallback fournisseur (pas d'entrée en stock) :
        // - 1 seul fournisseur → on l'utilise directement
        // - plusieurs → celui avec preference = 1
        if let Some(Value::Array(fous)) = get(&ref_data, "fournisseurs") {
            if !fous.is_empty() {
                let pick = if fous.len() == 1 {
                    &fous[0]
                } else {
                    fous.iter()
                        .find(|f| get(f, "preference").and_then(|p| p.as_f64()) == Some(1.0))
                        .unwrap_or(&fous[0])
                };
                let nom = get(pick, "nom_fou").and_then(|v| v.as_str()).map(|s| s.trim()).unwrap_or("");
                let code = get(pick, "codefou").and_then(|v| v.as_str()).map(|s| s.trim()).unwrap_or("");
                ref_fournisseur_fallback = if !nom.is_empty() { nom.to_string() } else { code.to_string() };
            }
        }
    }

    // Fournisseur réel : /dernier-fournisseur (dernière entrée en stock par site)
    // Fallback : premier non-dépôt du référentiel
    if dernier_res.status().is_success() {
        let dernier_data: Value = dernier_res.json().await?;
        // Prendre le fournisseur du premier site disponible
        let first = arr(&dernier_data, "fournisseurs_par_site")
            .iter()
            .find(|e| get(e, "nom_fournisseur").map(truthy).unwrap_or(false));
        if let Some(e) = first {
            out.fournisseur = Some(str_field(e, "nom_fournisseur").trim().to_string());
        } else if !ref_fournisseur_fallback.is_empty() {
            out.fournisseur = Some(ref_fournisseur_fallback);
        }
    } else if !ref_fournisseur_fallback.is_empty() {
        out.fournisseur = Some(ref_fournisseur_fallback);
    }
    Ok(())
}

/// Retourne toutes les données nécessaires pour le dashboard quotidien.
/// 100% via l'API REST api.ffnancy.fr — aucune requête PostgreSQL directe.
/// N-1 : même jour de semaine (52 semaines = 364 jours avant hier).
pub async fn pg_get_dashboard_data() -> anyhow::Result<DashboardData> {
    let yesterday = Local::now() - chrono::Duration::days(1);
    let date_hier = yesterday.with_timezone(&Utc).format("%Y-%m-%d").to_string();

    // N-1 : même jour de semaine, même semaine N-1 → 364 jours = 52 semaines exactes
    let n1_date = yesterday - chrono::Duration::days(364);
    let date_n1_param = n1_date.with_timezone(&Utc).format("%Y-%m-%d").to_string();

    let ff_api_base = get_ff_api_base().await;
    let api_base = format!("{ff_api_base}/api/performance");

    // Deux appels parallèles : données hier + données même jour N-1
    let (api_result, api_n1_result) = tokio::join!(
        async {
            let r = ff_get(&format!("{api_base}/dashboard?date={date_hier}")).await?;
            if !r.status().is_success() {
                anyhow::bail!("API dashboard {}: {}", r.status().as_u16(), status_text(r.status()));
            }
            anyhow::Ok(r.json::<Value>().await?)
        },
        async {
            match ff_get(&format!("{api_base}/dashboard?date={date_n1_param}")).await {
                Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
                _ => None,
            }
        },
    );
    let api_result = api_result?;
    if !api_result.is_object() {
        anyhow::bail!("API dashboard : réponse inattendue");
    }

    // Construire map N-1 par site depuis l'appel séparé
    let mut n1_by_site: HashMap<String, (f64, f64)> = HashMap::new();
    if let Some(n1) = api_n1_result.as_ref() {
        for s in arr(n1, "sites") {
            n1_by_site.insert(
                str_field(s, "site"),
                (js_number_or0(get(s, "ca_ttc").unwrap_or(&Value::Null)), js_number_or0(get(s, "trafic").unwrap_or(&Value::Null))),
            );
        }
    }

    let num = |v: &Value, k: &str| js_number_or0(get(v, k).unwrap_or(&Value::Null));

    let sites: Vec<DashboardSiteStats> = arr(&api_result, "sites")
        .iter()
        .map(|s| {
            let site = str_field(s, "site");
            let n1 = n1_by_site.get(&site);
            // Priorité : même jour de semaine N-1 (si > 0), sinon fallback sur n1 calendaire de l'API
            let ca_n1 = match n1 {
                Some((ca, _)) if *ca > 0.0 => *ca,
                _ => num(s, "ca_ttc_n1"),
            };
            let traffic_n1 = match n1 {
                Some((_, t)) if *t > 0.0 => *t,
                _ => num(s, "trafic_n1"),
            };
            DashboardSiteStats {
                site,
                ca_hier: num(s, "ca_ttc"),
                ca_n1,
                tickets_hier: num(s, "trafic"),
                tickets_n1: traffic_n1,
                qte_hier: 0.0,
                marge_hier: 0.0,
                lignes_hier: 0.0,
            }
        })
        .collect();

    // Top 10 par magasin : grouper les items par site, trier, garder top 10
    let all_items: Vec<&Value> = arr(&api_result, "top10_ca")
        .iter()
        .chain(arr(&api_result, "top10_qte"))
        .chain(arr(&api_result, "top10_marge"))
        .collect();
    let mut seen = HashSet::new();
    let all_codeins: Vec<String> = all_items
        .iter()
        .filter_map(|i| get(i, "codein").filter(|v| truthy(v)).map(js_string))
        .filter(|c| seen.insert(c.clone()))
        .collect();

    // Fournisseur réel : un seul appel sur les mouvements du jour (codefou_reel / nom_fournisseur_reel).
    // Enrichissement : fournisseur réel via /dernier-fournisseur (primaire) + /referentiel (stock + fallback fournisseur).
    // Les deux appels sont faits en parallèle par article.
    let mut fou_map: HashMap<String, String> = HashMap::new(); // codein → nom_fournisseur résolu
    let mut stock_map: HashMap<String, StockSites> = HashMap::new();

    if !all_codeins.is_empty() {
        // Vagues de 12 articles au lieu de 5 : chaque article coûte deux allers-
        // retours successifs, et la page d'accueil attendait une douzaine de vagues.
        const VAGUE: usize = 12;
        for batch in all_codeins.chunks(VAGUE) {
            let results = futures::future::join_all(batch.iter().map(|codein| {
                let base = ff_api_base.clone();
                async move {
                    let mut out = EnrichissementDashboard::default();
                    if let Err(err) = enrichir_article_dashboard(&base, codein, &mut out).await {
                        tracing::error!("[Dashboard enrichment] Error for codein {codein}: {}", message_erreur(&err));
                    }
                    (codein.clone(), out)
                }
            }))
            .await;
            for (codein, out) in results {
                if let Some(st) = out.stock {
                    stock_map.insert(codein.clone(), st);
                }
                if let Some(f) = out.fournisseur {
                    fou_map.insert(codein, f);
                }
            }
        }
    }

    let mut site_set: Vec<String> = all_items
        .iter()
        .filter_map(|i| get(i, "site").filter(|v| truthy(v)).map(js_string))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    site_set.sort();

    #[derive(Clone, Copy)]
    enum Cle {
        Ca,
        Qte,
        Marge,
    }
    let build_top10 = |items: Vec<&Value>, cle: Cle| -> Vec<DashboardTopItem> {
        let mut v: Vec<DashboardTopItem> = items
            .into_iter()
            .map(|i| {
                let codein = str_field(i, "codein");
                let site = get(i, "site").and_then(|v| v.as_str());
                let entry = stock_map.get(&codein);
                let stock = match site {
                    Some("292") => entry.map(|e| e.stock292).unwrap_or(0.0),
                    Some("579") => entry.map(|e| e.stock579).unwrap_or(0.0),
                    _ => entry.map(|e| e.stock_total).unwrap_or(0.0),
                };
                let fournisseur = fou_map.get(&codein).cloned().unwrap_or_else(|| "—".into());
                DashboardTopItem {
                    codein,
                    libelle1: str_field(i, "libelle1"),
                    ca: num(i, "ca_ttc"),
                    qte: num(i, "qte_vendue"),
                    marge: num(i, "marge"),
                    stock,
                    fournisseur,
                }
            })
            .collect();
        let key = |x: &DashboardTopItem| match cle {
            Cle::Ca => x.ca,
            Cle::Qte => x.qte,
            Cle::Marge => x.marge,
        };
        v.sort_by(|a, b| key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal));
        v.truncate(10);
        v
    };

    let top10_by_site: Vec<DashboardSiteTop10> = site_set
        .iter()
        .map(|site| {
            let by_s = |key: &str| -> Vec<&Value> {
                arr(&api_result, key).iter().filter(|i| get(i, "site").and_then(|v| v.as_str()) == Some(site.as_str())).collect()
            };
            DashboardSiteTop10 {
                site: site.clone(),
                ca: build_top10(by_s("top10_ca"), Cle::Ca),
                qte: build_top10(by_s("top10_qte"), Cle::Qte),
                marge: build_top10(by_s("top10_marge"), Cle::Marge),
            }
        })
        .collect();

    tracing::info!(
        "[pg-ff] Dashboard: hier={date_hier} n1={date_n1_param} sites={} n1_found={}",
        sites.len(),
        n1_by_site.len()
    );

    let date_of = |v: Option<&Value>, defaut: &str| match v.and_then(|v| get(v, "date")) {
        None | Some(Value::Null) => defaut.to_string(),
        Some(x) => js_string(x),
    };
    Ok(DashboardData {
        date_hier: date_of(Some(&api_result), &date_hier),
        date_n1: date_of(api_n1_result.as_ref(), &date_n1_param),
        sites,
        top10_by_site,
    })
}

// ---------------------------------------------------------------------------
// Analytics — CA TTC par fournisseur et nomenclature
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct CaByFournisseurRow {
    pub code: String,
    pub nom: String,
    pub site: String,
    pub mois: String,
    pub ca_ttc: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CaByNomenclatureRow {
    pub code: String,
    pub libelle: String,
    pub site: String,
    pub mois: String,
    pub ca_ttc: f64,
}

/// Bornes d'un mois « YYYY-MM » : [premier jour, premier jour du mois suivant[.
///
/// Filtrer `datmvt` sur ces bornes plutôt que sur `TO_CHAR(datmvt, 'YYYY-MM')`
/// donne exactement les mêmes lignes, mais sans formater en texte la date de
/// chaque mouvement de l'historique (et reste utilisable par un index sur datmvt).
pub fn bornes_mois(mois: &str) -> (String, String) {
    let mut parts = mois.split('-').map(|p| p.trim().parse::<i64>().ok());
    let annee = parts.next().flatten();
    let m = parts.next().flatten();
    let num = |v: Option<i64>| v.map(|x| x.to_string()).unwrap_or_else(|| "NaN".into());
    let suivant = if m == Some(12) {
        format!("{}-01", num(annee.map(|a| a + 1)))
    } else {
        format!("{}-{:0>2}", num(annee), num(m.map(|x| x + 1)))
    };
    (format!("{mois}-01"), format!("{suivant}-01"))
}

/// Mouvements du mois OU du mois N-1 (cf. `bornes_mois`).
fn push_filtre_deux_mois(qb: &mut QueryBuilder<'_, Postgres>, mois: &str, mois_n1: &str) {
    let (a_debut, a_fin) = bornes_mois(mois);
    let (b_debut, b_fin) = bornes_mois(mois_n1);
    qb.push("((m.datmvt >= ")
        .push_bind(a_debut)
        .push("::date AND m.datmvt < ")
        .push_bind(a_fin)
        .push("::date)\n            OR (m.datmvt >= ")
        .push_bind(b_debut)
        .push("::date AND m.datmvt < ")
        .push_bind(b_fin)
        .push("::date))");
}

/// Retourne le CA TTC par fournisseur et site pour deux mois donnés (mois et mois N-1).
/// Attribution via artfou1.preference = true (fournisseur principal de l'article).
/// CA NET : SUM(-mntmvtttc) — les retours clients sont déduits (même convention
/// que pg_get_mensuel_by_fournisseur / pg_get_hit_parade). Fournisseur préféré résolu
/// via une sous-requête artfou1 dédupliquée (DISTINCT ON) : un seul code par
/// article, aucune duplication possible des mouvements dans la somme.
pub async fn pg_get_ca_by_fournisseur(mois: &str, mois_n1: &str) -> anyhow::Result<Vec<CaByFournisseurRow>> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "
        SELECT
            COALESCE(af.code, 'SANS_FOURNISSEUR')::text              AS code,
            COALESCE(fi.nom, af.code, 'Sans fournisseur')::text       AS nom,
            m.site,
            TO_CHAR(m.datmvt, 'YYYY-MM')                             AS mois,
            SUM(-m.mntmvtttc)::float                                 AS ca_ttc
        FROM mvtart m
        JOIN articles a   ON a.no_id        = m.artnoid
        LEFT JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
        LEFT JOIN fouident fi ON fi.code     = af.code
        WHERE ",
    );
    push_filtre_deux_mois(&mut qb, mois, mois_n1);
    qb.push(
        "
          AND m.site IN ('292', '579')
          AND m.genremvt = 3
        GROUP BY af.code, fi.nom, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
        ORDER BY af.code, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
    ",
    );
    let rows = qb.build().fetch_all(&pool()?).await?;

    tracing::info!("[pg-ff] CaByFournisseur: {} lignes pour {mois}/{mois_n1}", rows.len());
    Ok(rows
        .iter()
        .map(|r| CaByFournisseurRow { code: s(r, "code"), nom: s(r, "nom"), site: s(r, "site"), mois: s(r, "mois"), ca_ttc: f(r, "ca_ttc") })
        .collect())
}

/// Retourne le CA TTC par nomenclature et site pour deux mois donnés.
/// CA NET : SUM(-mntmvtttc) — retours clients déduits (convention commune).
pub async fn pg_get_ca_by_nomenclature(mois: &str, mois_n1: &str) -> anyhow::Result<Vec<CaByNomenclatureRow>> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "
        SELECT
            COALESCE(n.code, 'SANS_NOM')::text      AS code,
            COALESCE(n.libelle, 'Sans nomenclature')::text AS libelle,
            m.site,
            TO_CHAR(m.datmvt, 'YYYY-MM')            AS mois,
            SUM(-m.mntmvtttc)::float                 AS ca_ttc
        FROM mvtart m
        JOIN articles      a ON a.no_id    = m.artnoid
        LEFT JOIN nomenclature n ON n.no_id = a.nom_no_id
        WHERE ",
    );
    push_filtre_deux_mois(&mut qb, mois, mois_n1);
    qb.push(
        "
          AND m.site IN ('292', '579')
          AND m.genremvt = 3
        GROUP BY n.no_id, n.code, n.libelle, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
        ORDER BY n.code, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
    ",
    );
    let rows = qb.build().fetch_all(&pool()?).await?;

    tracing::info!("[pg-ff] CaByNomenclature: {} lignes pour {mois}/{mois_n1}", rows.len());
    Ok(rows
        .iter()
        .map(|r| CaByNomenclatureRow {
            code: s(r, "code"),
            libelle: s(r, "libelle"),
            site: s(r, "site"),
            mois: s(r, "mois"),
            ca_ttc: f(r, "ca_ttc"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Hit Parade — produits les plus vendus sur un mois donné
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct HitParadeRow {
    pub codein: String,
    pub libelle: String,
    /// Référence fournisseur de l'article (artfou1.reference du fournisseur principal).
    pub reference: String,
    pub fournisseur: String,
    pub nomenclature_code: String,
    pub nomenclature: String,
    pub site: String,
    pub qte_vendue: f64,
    pub ca_ttc: f64,
    pub marge: f64,
    pub stock292: f64,
    pub stock579: f64,
    #[serde(rename = "stockTotal")]
    pub stock_total: f64,
}

/// Retourne les ventes produit sur une période, avec fournisseur, qté, CA TTC, marge et stock par site.
///
/// L'agrégation des ventes se fait UNIQUEMENT sur mvtart × articles (jointure 1:1),
/// exactement comme pg_get_mensuel_by_fournisseur (le calcul canonique de la Grille) :
/// qte = SUM(-qtemvt), ca = SUM(-mntmvtttc), marge = SUM(margemvt) pour genremvt = 3
/// (ventes stockées en négatif — vérifié sur les mouvements réels de l'API).
/// Les attributs (libellé, fournisseur préféré, nomenclature) et le stock sont
/// joints APRÈS l'agrégation, par codein : aucune jointure ne peut dupliquer les
/// mouvements et fausser les sommes, et le LATERAL fournisseur ne s'exécute que
/// par article vendu (et non par ligne de mouvement).
///
/// Fournisseur affiché : le principal (`artfou1.preference = 1`) s'il existe,
/// sinon n'importe quel fournisseur référencé — cherché sur toutes les fiches
/// portant le même codein (ré-créations d'article), la plus récente d'abord.
/// Exiger `preference = 1` laissait en « Sans fournisseur » les articles dont
/// la préférence n'est pas renseignée dans FF ou n'est posée que sur une
/// ancienne fiche du même codein.
///
/// Cas vérifié (codein 487673, site 579, jan→juil 2026) : 31 ventes brutes,
/// 7 retours clients → 24 net. L'ancien SUM(ABS(qtemvt)) affichait 38 (retours
/// additionnés) ; SUM(-qtemvt) donne 24, identique à l'API mensuel officielle.
pub async fn pg_get_hit_parade(date_debut: &str, date_fin: &str) -> anyhow::Result<Vec<HitParadeRow>> {
    let rows = sqlx::query(
        r#"
        WITH ventes AS (
            SELECT
                TRIM(a.codein::text)                                           AS codein,
                m.site,
                SUM(-m.qtemvt)::float                                          AS qte_vendue,
                SUM(-m.mntmvtttc)::float                                       AS ca_ttc,
                SUM(m.margemvt)::float                                          AS marge
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            WHERE m.datmvt BETWEEN $1::date AND $2::date
              AND m.site IN ('292', '579')
              AND m.genremvt = 3
              AND a.codein IS NOT NULL
            GROUP BY TRIM(a.codein::text), m.site
        ),
        fou AS (
            SELECT DISTINCT ON (TRIM(a.codein::text))
                TRIM(a.codein::text)                                    AS codein,
                af1.code,
                af1.reference
            FROM articles a
            JOIN artfou1 af1 ON af1.art_no_id = a.no_id
            WHERE TRIM(a.codein::text) IN (SELECT codein FROM ventes)
            ORDER BY TRIM(a.codein::text),
                     (af1.preference = 1) DESC NULLS LAST,
                     a.no_id DESC,
                     af1.no_id DESC
        ),
        attrs AS (
            SELECT DISTINCT ON (TRIM(a.codein::text))
                TRIM(a.codein::text)                                    AS codein,
                a.libelle1::text                                        AS libelle,
                COALESCE(TRIM(af.reference::text), '')                  AS reference,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text     AS fournisseur,
                COALESCE(n.code, '')::text                              AS nomenclature_code,
                COALESCE(n.libelle, 'Sans nomenclature')::text          AS nomenclature
            FROM articles a
            LEFT JOIN fou af ON af.codein = TRIM(a.codein::text)
            LEFT JOIN fouident fi ON fi.code = af.code
            LEFT JOIN nomenclature n ON n.no_id = a.nom_no_id
            WHERE TRIM(a.codein::text) IN (SELECT codein FROM ventes)
            ORDER BY TRIM(a.codein::text), a.no_id DESC
        ),
        stock_agg AS (
            SELECT
                TRIM(a2.codein::text)                                         AS codein,
                SUM(CASE WHEN cs.site = '292' THEN cs.qte ELSE 0 END)::float AS stock292,
                SUM(CASE WHEN cs.site = '579' THEN cs.qte ELSE 0 END)::float AS stock579,
                SUM(cs.qte)::float                                            AS stockTotal
            FROM cube_stock cs
            JOIN articles a2 ON a2.no_id = cs.artnoid
            WHERE TRIM(a2.codein::text) IN (SELECT codein FROM ventes)
            GROUP BY TRIM(a2.codein::text)
        )
        SELECT
            v.codein,
            COALESCE(ar.libelle, '')                          AS libelle,
            COALESCE(ar.reference, '')                        AS reference,
            COALESCE(ar.fournisseur, 'Sans fournisseur')      AS fournisseur,
            COALESCE(ar.nomenclature_code, '')                AS nomenclature_code,
            COALESCE(ar.nomenclature, 'Sans nomenclature')    AS nomenclature,
            v.site,
            v.qte_vendue,
            v.ca_ttc,
            v.marge,
            COALESCE(s.stock292, 0)    AS stock292,
            COALESCE(s.stock579, 0)    AS stock579,
            COALESCE(s.stockTotal, 0)  AS "stockTotal"
        FROM ventes v
        LEFT JOIN attrs ar     ON ar.codein = v.codein
        LEFT JOIN stock_agg s  ON s.codein  = v.codein
        ORDER BY v.ca_ttc DESC
    "#,
    )
    .bind(date_debut)
    .bind(date_fin)
    .fetch_all(&pool()?)
    .await?;

    tracing::info!("[pg-ff] HitParade: {} lignes pour {date_debut}→{date_fin}", rows.len());
    Ok(rows
        .iter()
        .map(|r| HitParadeRow {
            codein: s(r, "codein"),
            libelle: s(r, "libelle"),
            reference: s(r, "reference"),
            fournisseur: s(r, "fournisseur"),
            nomenclature_code: s(r, "nomenclature_code"),
            nomenclature: s(r, "nomenclature"),
            site: s(r, "site"),
            qte_vendue: f(r, "qte_vendue"),
            ca_ttc: f(r, "ca_ttc"),
            marge: f(r, "marge"),
            stock292: f(r, "stock292"),
            stock579: f(r, "stock579"),
            stock_total: f(r, "stockTotal"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Stock par liste de codeins (pour Hit Parade)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct StockBySite {
    pub stock292: f64,
    pub stock579: f64,
    #[serde(rename = "stockTotal")]
    pub stock_total: f64,
}

/// Retourne le stock actuel (stockdispo) par codein pour une liste de codeins.
/// 1 seule requête bulk — utilisé pour enrichir le Hit Parade.
pub async fn pg_get_stock_for_codeins(codeins: &[String]) -> anyhow::Result<HashMap<String, StockBySite>> {
    if codeins.is_empty() {
        return Ok(HashMap::new());
    }

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT TRIM(a.codein::text) AS codein, cs.site, COALESCE(cs.qte, 0)::float AS stockdispo
            FROM cube_stock cs
            JOIN articles a ON a.no_id = cs.artnoid
            WHERE TRIM(a.codein::text) IN (",
    );
    let mut sep = qb.separated(", ");
    for c in codeins {
        sep.push_bind(c.clone());
    }
    qb.push(")");
    let rows = qb.build().fetch_all(&pool()?).await?;

    let mut map: HashMap<String, StockBySite> = HashMap::new();
    for r in &rows {
        let entry = map.entry(s(r, "codein")).or_default();
        let dispo = f(r, "stockdispo");
        match os(r, "site").as_deref() {
            Some("292") => entry.stock292 += dispo,
            Some("579") => entry.stock579 += dispo,
            _ => {}
        }
        entry.stock_total += dispo;
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// Stock — fournisseur de la dernière entrée
// ---------------------------------------------------------------------------

/// Colonne de `mvtart` reliant un mouvement de stock à un fournisseur.
///  - target "artfou1" : la colonne est une FK vers `artfou1.no_id`
///  - target "code"    : la colonne contient directement le code fournisseur (`fouident.code`)
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct MvtartFouLink {
    pub column: &'static str,
    pub target: &'static str,
}

/// Colonnes candidates de `mvtart` reliant un mouvement de stock à un fournisseur.
/// `mvtart` provient d'une réplication FF : le nom exact n'est pas garanti, on le
/// détecte une fois par process (même principe que `get_nomenclature_parent_col`).
pub const MVTART_FOU_CANDIDATES: [MvtartFouLink; 7] = [
    MvtartFouLink { column: "artfou1_no_id", target: "artfou1" },
    MvtartFouLink { column: "artfou_no_id", target: "artfou1" },
    MvtartFouLink { column: "afou_no_id", target: "artfou1" },
    MvtartFouLink { column: "codefou", target: "code" },
    MvtartFouLink { column: "code_fou", target: "code" },
    MvtartFouLink { column: "fou_code", target: "code" },
    MvtartFouLink { column: "fournisseur", target: "code" },
];

static MVTART_FOU_LINK: OnceCell<Option<MvtartFouLink>> = OnceCell::const_new();

async fn get_mvtart_fou_link() -> Option<MvtartFouLink> {
    *MVTART_FOU_LINK
        .get_or_init(|| async {
            let res = async {
                let rows = sqlx::query(
                    r#"
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'mvtart'
        "#,
                )
                .fetch_all(&pool()?)
                .await?;
                anyhow::Ok(rows.iter().map(|r| s(r, "column_name").to_lowercase()).collect::<HashSet<_>>())
            }
            .await;
            // Le nom vient d'information_schema ET doit figurer dans la liste blanche
            // ci-dessus : aucune valeur utilisateur n'atteint le SQL.
            let link = match res {
                Ok(cols) => MVTART_FOU_CANDIDATES.iter().find(|c| cols.contains(c.column)).copied(),
                Err(e) => {
                    tracing::error!("[pg-ff] Détection mvtart.fournisseur impossible: {}", message_erreur(&e));
                    None
                }
            };
            match link {
                Some(l) => tracing::info!("[pg-ff] mvtart → fournisseur: {{ column: '{}', target: '{}' }}", l.column, l.target),
                None => tracing::info!("[pg-ff] mvtart → fournisseur: aucune colonne (repli artfou1.preference=1)"),
            }
            link
        })
        .await
}

/// Jointure latérale sur la DERNIÈRE entrée en stock (`genremvt IN (1,2)`) du
/// couple article/site : elle expose `lastentry.datmvt` (date) et
/// `lastentry.code` (code fournisseur, `NULL` si la base ne porte pas
/// l'information).
///
/// Règle métier : un article n'est rattaché qu'au fournisseur de sa dernière
/// entrée. S'il est rentré en stock chez un autre fournisseur, il ne doit plus
/// apparaître sous le précédent.
///
/// La `LEFT JOIN artfou1` (et non `JOIN`) garantit qu'on retient bien la vraie
/// dernière entrée, même si son fournisseur est inconnu.
///
/// Les expressions passées sont des fragments SQL constants du code, et la
/// colonne vient de la liste blanche : aucune valeur utilisateur ici.
fn last_entry_join(link: Option<MvtartFouLink>, artnoid_expr: &str, site_expr: &str) -> String {
    let code_expr = match link {
        Some(l) if l.target == "artfou1" => "afe.code".to_string(),
        Some(l) => format!("me.{}", l.column),
        None => "NULL::text".to_string(),
    };
    let join_artfou = match link {
        Some(l) if l.target == "artfou1" => format!("LEFT JOIN artfou1 afe ON afe.no_id = me.{}", l.column),
        _ => String::new(),
    };
    let flast = if link.is_some() { "LEFT JOIN fouident flast ON flast.code = lastentry.code" } else { "" };
    format!(
        "
        LEFT JOIN LATERAL (
            SELECT me.datmvt, {code_expr} AS code
            FROM mvtart me
            {join_artfou}
            WHERE me.artnoid = {artnoid_expr}
              AND me.site = {site_expr}
              AND me.genremvt IN (1, 2)
            ORDER BY me.datmvt DESC, me.no_id DESC
            LIMIT 1
        ) lastentry ON TRUE
        {flast}
    "
    )
}

/// Libellé fournisseur affiché : celui de la dernière entrée quand la base le
/// permet, sinon repli documenté sur `artfou1.preference = 1`.
fn fournisseur_expr(link: Option<MvtartFouLink>) -> &'static str {
    if link.is_some() {
        "COALESCE(flast.nom, lastentry.code, f.nom, af.code)"
    } else {
        "COALESCE(f.nom, af.code)"
    }
}

/// Résultat du diagnostic « fournisseur de la dernière entrée ».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagFournisseurDerniereEntree {
    pub colonne_detectee: Option<MvtartFouLink>,
    pub candidats_testes: Vec<&'static str>,
    pub colonnes_mvtart: Vec<Value>,
    pub echantillon: Vec<Value>,
}

/// Diagnostic (`/api/diag/stock-fournisseur`) : expose la colonne détectée, les
/// colonnes réellement présentes sur `mvtart` et un échantillon comparant le
/// fournisseur principal au fournisseur de la dernière entrée.
pub async fn pg_diag_fournisseur_derniere_entree() -> anyhow::Result<DiagFournisseurDerniereEntree> {
    let link = get_mvtart_fou_link().await;
    let pool = pool()?;
    let meta = sqlx::query(
        r#"
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'mvtart' ORDER BY ordinal_position
    "#,
    )
    .fetch_all(&pool)
    .await?;
    let mut echantillon = vec![];
    if link.is_some() {
        let sql = format!(
            "
            SELECT
                a.codein,
                cs.site,
                COALESCE(f.nom, af.code)              AS fournisseur_preference,
                COALESCE(flast.nom, lastentry.code)   AS fournisseur_derniere_entree,
                lastentry.datmvt::text                AS derniere_entree
            FROM cube_stock cs
            JOIN articles a ON a.no_id = cs.artnoid
            JOIN (
                SELECT DISTINCT ON (art_no_id) art_no_id, code
                FROM artfou1
                WHERE preference = 1
                ORDER BY art_no_id, code
            ) af ON af.art_no_id = a.no_id
            LEFT JOIN fouident f ON f.code = af.code
            {}
            WHERE cs.qte < 0
              AND cs.site IN ('292', '579')
            LIMIT 20
        ",
            last_entry_join(link, "cs.artnoid", "cs.site")
        );
        let r = sqlx::query(&sql).fetch_all(&pool).await?;
        echantillon = rows_to_json(&r);
    }
    Ok(DiagFournisseurDerniereEntree {
        colonne_detectee: link,
        candidats_testes: MVTART_FOU_CANDIDATES.iter().map(|c| c.column).collect(),
        colonnes_mvtart: meta
            .iter()
            .map(|r| json!({ "column_name": s(r, "column_name"), "data_type": s(r, "data_type") }))
            .collect(),
        echantillon,
    })
}

// ---------------------------------------------------------------------------
// Stock négatif — tous magasins ou par site
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgStockNegatifRow {
    pub codein: String,
    pub libelle1: String,
    pub fournisseur: String,
    pub site: String,
    pub stockdispo: f64,
    pub dernierevente: Option<String>,
    pub derniereentree: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgStockSansVenteRow {
    pub codein: String,
    pub libelle1: String,
    pub fournisseur: String,
    pub site: String,
    pub stock_actuel: f64,
    pub derniere_entree: Option<String>,
}

/// Retourne les articles ayant des entrées en stock (hors mois courant)
/// mais aucune vente enregistrée sur ce site.
/// Les articles dont le stock actuel est nul sont exclus (rien à régulariser).
pub async fn pg_get_stock_sans_vente(site: Option<&str>) -> anyhow::Result<Vec<PgStockSansVenteRow>> {
    let link = get_mvtart_fou_link().await;
    let fexpr = fournisseur_expr(link);
    let mut qb = QueryBuilder::<Postgres>::new(format!(
        "
        SELECT
            a.codein,
            COALESCE(a.libelle1, '') AS libelle1,
            {fexpr} AS fournisseur,
            m.site,
            COALESCE(cs.qte::float, 0) AS stock_actuel,
            MAX(m.datmvt)::text AS derniere_entree
        FROM mvtart m
        JOIN articles a ON a.no_id = m.artnoid
        JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
        JOIN fouident f ON f.code = af.code
        LEFT JOIN cube_stock cs ON cs.artnoid = a.no_id AND cs.site = m.site
        {}
        WHERE m.genremvt IN (1, 2)
          AND m.site IN ('292', '579')
          AND m.datmvt < date_trunc('month', CURRENT_DATE)
          ",
        last_entry_join(link, "a.no_id", "m.site")
    ));
    if let Some(site) = site.filter(|s| !s.is_empty()) {
        qb.push("AND m.site = ").push_bind(site.to_string());
    }
    qb.push(format!(
        "
          AND NOT EXISTS (
              SELECT 1 FROM mvtart mv2
              WHERE mv2.artnoid = m.artnoid
                AND mv2.site = m.site
                AND mv2.genremvt = 3
          )
        GROUP BY a.codein, a.libelle1, {fexpr}, m.site, cs.qte
        HAVING COALESCE(cs.qte::float, 0) <> 0
        ORDER BY MAX(m.datmvt) DESC
    "
    ));
    let rows = qb.build().fetch_all(&pool()?).await?;
    Ok(rows
        .iter()
        .map(|r| PgStockSansVenteRow {
            codein: s(r, "codein"),
            libelle1: s(r, "libelle1"),
            fournisseur: s(r, "fournisseur"),
            site: s(r, "site"),
            stock_actuel: f(r, "stock_actuel"),
            derniere_entree: os(r, "derniere_entree"),
        })
        .collect())
}

pub async fn pg_get_stock_negatif(site: Option<&str>) -> anyhow::Result<Vec<PgStockNegatifRow>> {
    let link = get_mvtart_fou_link().await;
    let mut qb = QueryBuilder::<Postgres>::new(format!(
        "
        SELECT
            a.codein,
            COALESCE(a.libelle1, '') AS libelle1,
            {} AS fournisseur,
            cs.site,
            cs.qte::float AS stockdispo,
            cs.dernierevente::text,
            lastentry.datmvt::text AS derniereentree
        FROM cube_stock cs
        JOIN articles a ON a.no_id = cs.artnoid
        JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
        JOIN fouident f ON f.code = af.code
        {}
        WHERE cs.qte < 0
          AND cs.site IN ('292', '579')
        ",
        fournisseur_expr(link),
        last_entry_join(link, "cs.artnoid", "cs.site")
    ));
    if let Some(site) = site.filter(|s| !s.is_empty()) {
        qb.push("AND cs.site = ").push_bind(site.to_string());
    }
    qb.push(
        "
        ORDER BY cs.qte ASC
    ",
    );
    let rows = qb.build().fetch_all(&pool()?).await?;
    Ok(rows
        .iter()
        .map(|r| PgStockNegatifRow {
            codein: s(r, "codein"),
            libelle1: s(r, "libelle1"),
            fournisseur: s(r, "fournisseur"),
            site: s(r, "site"),
            stockdispo: f(r, "stockdispo"),
            dernierevente: os(r, "dernierevente"),
            derniereentree: os(r, "derniereentree"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Stock sans vente depuis 6 mois
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgSansVente6MoisRow {
    pub codein: String,
    pub libelle1: String,
    pub fournisseur: String,
    pub site: String,
    pub stock_actuel: f64,
    pub derniere_vente: Option<String>,
    pub derniere_entree: Option<String>,
    pub jours_sans_vente: Option<i64>,
}

/// Retourne les articles ayant du stock disponible (qte > 0)
/// dont la dernière vente remonte à plus de 6 mois (ou jamais vendus)
/// ET dont la dernière entrée en stock remonte aussi à plus de 6 mois.
pub async fn pg_get_sans_vente_6_mois(site: Option<&str>) -> anyhow::Result<Vec<PgSansVente6MoisRow>> {
    let link = get_mvtart_fou_link().await;
    let mut qb = QueryBuilder::<Postgres>::new(format!(
        "
        SELECT
            a.codein,
            COALESCE(a.libelle1, '') AS libelle1,
            {} AS fournisseur,
            cs.site,
            cs.qte::float AS stock_actuel,
            cs.dernierevente::text AS derniere_vente,
            CASE
                WHEN cs.dernierevente IS NULL THEN NULL
                ELSE (CURRENT_DATE - cs.dernierevente::date)
            END AS jours_sans_vente,
            lastentry.datmvt::text AS derniere_entree
        FROM cube_stock cs
        JOIN articles a ON a.no_id = cs.artnoid
        JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
        JOIN fouident f ON f.code = af.code
        {}
        WHERE cs.site IN ('292', '579')
          AND cs.qte > 0
          AND (
              cs.dernierevente IS NULL
              OR cs.dernierevente < CURRENT_DATE - INTERVAL '6 months'
          )
          AND NOT EXISTS (
              SELECT 1 FROM mvtart m2
              WHERE m2.artnoid = cs.artnoid
                AND m2.site = cs.site
                AND m2.genremvt IN (1, 2)
                AND m2.datmvt >= CURRENT_DATE - INTERVAL '6 months'
          )
          ",
        fournisseur_expr(link),
        last_entry_join(link, "cs.artnoid", "cs.site")
    ));
    if let Some(site) = site.filter(|s| !s.is_empty()) {
        qb.push("AND cs.site = ").push_bind(site.to_string());
    }
    qb.push(
        "
        ORDER BY cs.dernierevente ASC NULLS FIRST
    ",
    );
    let rows = qb.build().fetch_all(&pool()?).await?;
    Ok(rows
        .iter()
        .map(|r| PgSansVente6MoisRow {
            codein: s(r, "codein"),
            libelle1: s(r, "libelle1"),
            fournisseur: s(r, "fournisseur"),
            site: s(r, "site"),
            stock_actuel: f(r, "stock_actuel"),
            derniere_vente: os(r, "derniere_vente"),
            derniere_entree: os(r, "derniere_entree"),
            jours_sans_vente: oi(r, "jours_sans_vente"),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Commandes automatiques — par site + fournisseur avec franco
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct PgCommandeAutoRow {
    pub site: String,
    pub codefou: String,
    pub nomfou: String,
    pub franco: f64,
    pub nb_articles: f64,
    pub montant_cde: f64,
    pub franco_atteint: Option<bool>,
    pub ecart_franco: f64,
}

fn map_commande_auto_row(r: &Value) -> PgCommandeAutoRow {
    let s_or = |keys: &[&str]| coalesce(r, keys).map(js_string).unwrap_or_default();
    let n_or = |keys: &[&str]| coalesce(r, keys).map(js_number).unwrap_or(0.0);
    PgCommandeAutoRow {
        site: s_or(&["site"]),
        codefou: s_or(&["codefou"]),
        nomfou: s_or(&["nom_fou", "nomfou"]),
        franco: n_or(&["franco_ht", "franco"]),
        nb_articles: n_or(&["nb_articles"]),
        montant_cde: n_or(&["montant_propo_ht", "montant_cde"]),
        franco_atteint: match get(r, "franco_atteint") {
            Some(Value::String(v)) if v == "OUI" => Some(true),
            Some(Value::String(v)) if v == "NON" => Some(false),
            Some(Value::String(v)) if v == "N/A" => None,
            Some(v) if !v.is_null() => Some(truthy(v)),
            _ => None,
        },
        ecart_franco: n_or(&["ecart_franco"]),
    }
}

/// Franco lu dans le détail d'un fournisseur (`resume[0].franco_ht`).
fn extract_franco(detail: &Value) -> f64 {
    if !truthy(detail) || get(detail, "error").map(truthy).unwrap_or(false) {
        return 0.0;
    }
    let resume_raw = coalesce(detail, &["resume", "summary"]).unwrap_or(detail);
    let resume_item = match resume_raw {
        Value::Array(a) => a.first(),
        v => Some(v),
    };
    match resume_item.and_then(|i| coalesce(i, &["franco_ht", "franco"])) {
        Some(v) => js_number(v),
        None => 0.0,
    }
}

/// Retourne la liste des fournisseurs en commande automatique via l'API Hostinger.
/// GET https://api.ffnancy.fr/api/commandes-auto
///
/// Pour les fournisseurs dont le franco est absent de la réponse globale (franco_ht null),
/// on enrichit via le detail endpoint /api/commandes-auto/:codefou?site= qui contient
/// toujours le résumé franco du fournisseur.
///
/// Liste vide en cas d'erreur.
pub async fn pg_get_commandes_auto() -> Vec<PgCommandeAutoRow> {
    let res = async {
        let base = get_ff_api_base().await;
        let res = ff_get(&format!("{base}/api/commandes-auto")).await?;
        if !res.status().is_success() {
            anyhow::bail!("HTTP {}", res.status().as_u16());
        }
        let data: Value = res.json().await?;
        // L'API retourne { count: N, propositions: [...] } ou un tableau direct
        let rows: Vec<Value> = match &data {
            Value::Array(a) => a.clone(),
            d => match coalesce(d, &["propositions", "data", "items", "results"]) {
                None => vec![],
                Some(Value::Array(a)) => a.clone(),
                Some(_) => anyhow::bail!("rows.map is not a function"),
            },
        };

        // Diagnostic : log les clés du premier row pour détecter les changements de format
        if let Some(sample) = rows.first() {
            let keys: Vec<&String> = sample.as_object().map(|o| o.keys().collect()).unwrap_or_default();
            tracing::info!("[pg-ff] pgGetCommandesAuto sample keys: {keys:?}");
            let champ = |k: &str| match get(sample, k) {
                None => "undefined".to_string(),
                Some(v) => js_string(v),
            };
            tracing::info!(
                "[pg-ff] pgGetCommandesAuto sample franco fields: franco_ht={} franco={} franco_atteint={}",
                champ("franco_ht"),
                champ("franco"),
                champ("franco_atteint")
            );
        }

        tracing::info!("[pg-ff] pgGetCommandesAuto: {} lignes (API Hostinger)", rows.len());
        let mapped: Vec<PgCommandeAutoRow> = rows.iter().map(map_commande_auto_row).collect();

        // Enrichissement : pour les fournisseurs sans franco dans la réponse globale,
        // on appelle GET /api/commandes-auto/{codefou} (sans filtre site — franco est une
        // propriété du fournisseur, pas du site) et on lit resume[0].franco_ht.
        let missing: Vec<&PgCommandeAutoRow> = mapped.iter().filter(|r| r.franco == 0.0 && !r.codefou.is_empty()).collect();
        if missing.is_empty() {
            return anyhow::Ok(mapped);
        }
        tracing::info!("[pg-ff] pgGetCommandesAuto: {} lignes sans franco → enrichissement", missing.len());
        // Dédupliquer par codefou (franco identique quel que soit le site)
        let mut seen = HashSet::new();
        let unique_code_fous: Vec<String> =
            missing.iter().map(|r| r.codefou.clone()).filter(|c| seen.insert(c.clone())).collect();

        // 6 fournisseurs à la fois : chacun peut coûter deux appels successifs.
        let details = par_lots(unique_code_fous, 6, |codefou| {
            let base = base.clone();
            async move {
                let essai = |url: String| async move {
                    match ff_get(&url).await {
                        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                            Ok(detail) => extract_franco(&detail),
                            Err(_) => 0.0,
                        },
                        _ => 0.0,
                    }
                };
                // 1. Essai sans filtre site
                let f1 = essai(format!("{base}/api/commandes-auto/{}", encode(&codefou))).await;
                if f1 > 0.0 {
                    return (codefou, f1);
                }
                // 2. Fallback site=000
                let f2 = essai(format!("{base}/api/commandes-auto/{}?site=000", encode(&codefou))).await;
                if f2 > 0.0 {
                    return (codefou, f2);
                }
                (codefou, 0.0)
            }
        })
        .await;

        // Map codefou → franco enrichi
        let mut franco_map: Map<String, Value> = Map::new();
        for (codefou, franco) in details {
            if franco > 0.0 {
                franco_map.insert(codefou, json!(franco));
            }
        }
        let enrichis = serde_json::Value::Object(franco_map.clone()).to_string();
        tracing::info!("[pg-ff] pgGetCommandesAuto: francos enrichis: {enrichis}");

        Ok(mapped
            .into_iter()
            .map(|mut r| {
                if r.franco == 0.0 {
                    if let Some(enriched) = franco_map.get(&r.codefou).and_then(|v| v.as_f64()) {
                        if enriched > 0.0 {
                            r.franco = enriched;
                        }
                    }
                }
                r
            })
            .collect())
    }
    .await;
    match res {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetCommandesAuto error: {}", short(&message_erreur(&e), 300));
            vec![]
        }
    }
}

// ---------------------------------------------------------------------------
// 12. Dernière réception par fournisseur ET par site (cadencier)
// ---------------------------------------------------------------------------

/// Date ISO (`toISOString()`) d'une colonne date/horodatage, ou d'un texte de date.
fn colonne_iso(row: &PgRow, col: &str) -> anyhow::Result<Option<String>> {
    let raw = row.try_get_raw(col)?;
    if raw.is_null() {
        return Ok(None);
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    if matches!(ty.as_str(), "DATE" | "TIMESTAMP" | "TIMESTAMPTZ") {
        return Ok(get_string(row, col));
    }
    // Texte : `new Date(texte).toISOString()`.
    let txt = string_or_empty(row, col);
    let t = txt.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return Ok(Some(crate::db::iso_utc(d.with_timezone(&Utc))));
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(t, fmt) {
            return Ok(Some(crate::db::iso(d)));
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return Ok(Some(crate::db::iso(d.and_hms_opt(0, 0, 0).unwrap_or_default())));
    }
    anyhow::bail!("Invalid time value")
}

/// Retourne la date de la dernière réception (entrée de marchandise) par
/// fournisseur et par site, pour piloter le cadencier de commande.
///
/// Source : mvtart (genremvt IN (1, 2) = réceptions, voir pg_get_mensuel_by_fournisseur).
/// La réception est rattachée à l'article ; on l'attribue au fournisseur
/// principal de l'article (artfou1.preference = 1), comme partout ailleurs.
///
/// Clé de la Map : `${codefou}|${site}`. Map vide en cas d'erreur
/// (l'UI affichera alors « échéance inconnue »).
pub async fn pg_get_derniere_reception_par_fournisseur(codes: Option<&[String]>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    // Liste fournie (fournisseurs du cadencier) : on n'agrège que leurs articles,
    // au lieu de tout l'historique de réceptions de tous les fournisseurs.
    if codes.map(|c| c.is_empty()).unwrap_or(false) {
        return map;
    }
    let mut qb = QueryBuilder::<Postgres>::new(
        "
            SELECT
                af.code        AS codefou,
                m.site         AS site,
                MAX(m.datmvt)  AS derniere
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
            WHERE m.genremvt IN (1, 2)
              AND m.site IN ('292', '579')
              AND m.datmvt IS NOT NULL
              ",
    );
    if let Some(codes) = codes {
        qb.push("AND TRIM(af.code) IN (");
        let mut sep = qb.separated(", ");
        for c in codes {
            sep.push_bind(c.trim().to_string());
        }
        qb.push(")");
    }
    qb.push(
        "
            GROUP BY af.code, m.site
        ",
    );
    let res = async {
        let rows = qb.build().fetch_all(&pool()?).await?;
        for r in &rows {
            let codefou = s(r, "codefou");
            if codefou.is_empty() {
                continue;
            }
            let Some(iso) = colonne_iso(r, "derniere")? else { continue };
            map.insert(format!("{}|{}", codefou.trim(), s(r, "site").trim()), iso);
        }
        tracing::info!("[pg-ff] pgGetDerniereReceptionParFournisseur: {} entrées (mvtart)", map.len());
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = res {
        tracing::error!("[pg-ff] pgGetDerniereReceptionParFournisseur error: {}", short(&message_erreur(&e), 250));
    }
    map
}

// ---------------------------------------------------------------------------
// 13. Recherche & fiche produit (page /produits)
// ---------------------------------------------------------------------------

/// Une ligne de résultat de recherche produit. Volontairement **légère** :
/// aucune agrégation `mvtart` ici (le seq-scan du ILIKE domine déjà le coût).
/// Le détail lourd n'est calculé qu'à l'ouverture de la fiche.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PgProduitSearchRow {
    pub no_id: i64,
    pub codein: String,
    pub code_centrale: String,
    pub libelle1: String,
    /// Nom du fournisseur principal (artfou1.preference = 1), sinon son code.
    pub fournisseur: String,
    pub codefou: String,
    pub nomenclature_code: String,
    pub nomenclature: String,
    pub stock_total: f64,
    /// true si le produit a déjà des métriques réseau Qlik en cache.
    pub has_reseau: bool,
    pub qte_reseau: f64,
    pub nb_magasins_reseau: i64,
}

fn produit_search_row(r: &PgRow) -> PgProduitSearchRow {
    PgProduitSearchRow {
        no_id: oi(r, "no_id").unwrap_or(0),
        codein: s(r, "codein"),
        code_centrale: s(r, "code_centrale"),
        libelle1: s(r, "libelle1"),
        fournisseur: s(r, "fournisseur"),
        codefou: s(r, "codefou"),
        nomenclature_code: s(r, "nomenclature_code"),
        nomenclature: s(r, "nomenclature"),
        stock_total: f(r, "stock_total"),
        has_reseau: ob(r, "has_reseau").unwrap_or(false),
        qte_reseau: f(r, "qte_reseau"),
        nb_magasins_reseau: oi(r, "nb_magasins_reseau").unwrap_or(0),
    }
}

/// Caractères accentués et leur équivalent non accentué, pour `translate()`.
/// Les deux chaînes DOIVENT rester de même longueur, caractère par caractère.
/// Postgres n'a pas `unaccent()` sans l'extension : on ne peut pas compter dessus
/// sur la base FF, d'où cette table de correspondance explicite.
const SQL_ACCENTS_FROM: &str = "àâäãáåéèêëíìîïóòôöõúùûüçñýÿ";
const SQL_ACCENTS_TO: &str = "aaaaaaeeeeiiiiooooouuuucnyy";

/// Lettre de base d'un caractère latin accentué (équivalent de la
/// décomposition NFD suivie du retrait des diacritiques).
fn sans_accent(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' | 'ǎ' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' | 'Ǎ' => 'A',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'Ç' | 'Ć' | 'Ĉ' | 'Ċ' | 'Č' => 'C',
        'ď' => 'd',
        'Ď' => 'D',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' | 'Ě' => 'E',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'Ĝ' | 'Ğ' | 'Ġ' | 'Ģ' => 'G',
        'ĥ' => 'h',
        'Ĥ' => 'H',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ǐ' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ĩ' | 'Ī' | 'Ĭ' | 'Į' | 'İ' | 'Ǐ' => 'I',
        'ĵ' => 'j',
        'Ĵ' => 'J',
        'ķ' => 'k',
        'Ķ' => 'K',
        'ĺ' | 'ļ' | 'ľ' => 'l',
        'Ĺ' | 'Ļ' | 'Ľ' => 'L',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'Ñ' | 'Ń' | 'Ņ' | 'Ň' => 'N',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ŏ' | 'ő' | 'ǒ' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ō' | 'Ŏ' | 'Ő' | 'Ǒ' => 'O',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'Ŕ' | 'Ŗ' | 'Ř' => 'R',
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => 's',
        'Ś' | 'Ŝ' | 'Ş' | 'Š' | 'Ș' => 'S',
        'ţ' | 'ť' | 'ț' => 't',
        'Ţ' | 'Ť' | 'Ț' => 'T',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' | 'ǔ' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ũ' | 'Ū' | 'Ŭ' | 'Ů' | 'Ű' | 'Ų' | 'Ǔ' => 'U',
        'ŵ' => 'w',
        'Ŵ' => 'W',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'Ý' | 'Ÿ' | 'Ŷ' => 'Y',
        'ź' | 'ż' | 'ž' => 'z',
        'Ź' | 'Ż' | 'Ž' => 'Z',
        _ => return None,
    })
}

/// Retire les diacritiques (lettres latines précomposées et marques combinantes).
fn retirer_accents(s: &str) -> String {
    s.chars()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .map(|c| sans_accent(c).unwrap_or(c))
        .collect()
}

/// Normalise un terme de recherche, de la même façon que
/// `normalized_libelle_sql()` le fait côté SQL : minuscules, accents retirés,
/// toute ponctuation ramenée à un espace.
pub fn normalize_search_term(term: &str) -> String {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"[^a-z0-9]+").unwrap());
    let base = retirer_accents(&term.to_lowercase());
    RE.replace_all(&base, " ").trim().to_string()
}

/// Comparaison de chaînes approchant `localeCompare(…, "fr")` : casse et accents
/// ignorés au premier niveau.
pub fn compare_fr(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = retirer_accents(&a.to_lowercase());
    let pb = retirer_accents(&b.to_lowercase());
    pa.cmp(&pb).then_with(|| a.to_lowercase().cmp(&b.to_lowercase())).then_with(|| b.cmp(a))
}

/// Recherche un produit par **libellé** ou par **code centrale** (préfixe).
/// Si le terme est entièrement numérique, on tente aussi une correspondance
/// exacte sur le `codein`.
///
/// La recherche par libellé est **insensible aux accents et à la ponctuation**,
/// et fonctionne **mot à mot** : « tapis anti-poussière » retrouve
/// « TAPIS ANTI POUSSIERE », et « tapis poussiere » aussi (tous les mots doivent
/// être présents, dans n'importe quel ordre). Sans cette normalisation, un
/// `ILIKE` brut exigeait l'accent ET le tiret exacts et ne remontait rien.
///
/// ⚠️ Il n'existe aucun index texte sur `articles.libelle1` (base FF resynchronisée
/// chaque nuit depuis SQL Server — on n'y crée pas d'index). La requête fait donc
/// un seq-scan avec normalisation par ligne : l'appelant impose un minimum de
/// 3 caractères et une soumission explicite, jamais une recherche à la frappe.
///
/// `limit` : 50 dans le code d'origine. Liste vide en cas d'erreur.
pub async fn pg_search_produits(term: &str, limit: i64) -> Vec<PgProduitSearchRow> {
    let cleaned = term.trim();
    if cleaned.chars().count() < 3 {
        return vec![];
    }

    let prefix = format!("{cleaned}%");
    // Mots de la recherche, normalisés. Tous doivent être présents (AND).
    let normalized = normalize_search_term(cleaned);
    let tokens: Vec<&str> = normalized.split(' ').filter(|t| !t.is_empty()).collect();

    let mut qb = QueryBuilder::<Postgres>::new(
        "
            WITH raw AS (
                SELECT DISTINCT ON (TRIM(a.codein::text))
                    a.no_id,
                    TRIM(a.codein::text)                     AS codein,
                    COALESCE(TRIM(a.artcentrale::text), '')  AS code_centrale,
                    COALESCE(a.libelle1, '')                 AS libelle1,
                    a.nom_no_id
                FROM articles a
                WHERE a.codein IS NOT NULL
                  AND (
                        ",
    );
    if tokens.is_empty() {
        qb.push("FALSE");
    } else {
        qb.push("(");
        for (i, t) in tokens.iter().enumerate() {
            if i > 0 {
                qb.push(" AND ");
            }
            // Expression SQL renvoyant le libellé normalisé (minuscules, sans accent ni ponctuation).
            qb.push("regexp_replace(translate(lower(COALESCE(a.libelle1, '')), ")
                .push_bind(SQL_ACCENTS_FROM)
                .push(", ")
                .push_bind(SQL_ACCENTS_TO)
                .push("), '[^a-z0-9]+', ' ', 'g') LIKE ")
                .push_bind(format!("%{t}%"));
        }
        qb.push(")");
    }
    qb.push("\n                     OR TRIM(a.artcentrale::text) ILIKE ").push_bind(prefix).push("\n                     ");
    // Un terme purement numérique peut être un codein : on l'ajoute au filtre
    // (correspondance exacte, la colonne est space-padded d'où le TRIM).
    if cleaned.chars().all(|c| c.is_ascii_digit()) {
        qb.push("OR TRIM(a.codein::text) = ").push_bind(cleaned.to_string());
    }
    qb.push(
        "
                  )
                ORDER BY TRIM(a.codein::text), a.no_id DESC
            ),
            matched AS (
                SELECT * FROM raw ORDER BY libelle1 LIMIT ",
    );
    qb.push_bind(limit);
    qb.push(
        "
            )
            SELECT
                m.no_id,
                m.codein,
                m.code_centrale,
                m.libelle1,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur,
                COALESCE(af.code, '')::text                         AS codefou,
                COALESCE(n.code, '')::text                          AS nomenclature_code,
                COALESCE(n.libelle, '')::text                       AS nomenclature,
                COALESCE(st.stock_total, 0)::float                  AS stock_total,
                (q.code_centrale IS NOT NULL)                       AS has_reseau,
                COALESCE(q.qte_reseau, 0)::float                    AS qte_reseau,
                COALESCE(q.nb_magasins_reseau, 0)                   AS nb_magasins_reseau
            FROM matched m
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = m.no_id
                ORDER BY (af1.preference = 1) DESC NULLS LAST, af1.no_id DESC
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            LEFT JOIN nomenclature n ON n.no_id = m.nom_no_id
            LEFT JOIN LATERAL (
                SELECT SUM(cs.qte)::float AS stock_total
                FROM cube_stock cs
                WHERE cs.artnoid = m.no_id AND cs.site IN ('292', '579')
            ) st ON TRUE
            LEFT JOIN qlik_network_metrics q ON q.code_centrale = m.code_centrale
            ORDER BY m.libelle1
        ",
    );

    let res = async { anyhow::Ok(qb.build().fetch_all(&pool()?).await?) }.await;
    match res {
        Ok(rows) => {
            tracing::info!("[pg-ff] pgSearchProduits(\"{cleaned}\"): {} résultats", rows.len());
            rows.iter().map(produit_search_row).collect()
        }
        Err(e) => {
            tracing::error!("[pg-ff] pgSearchProduits error: {}", short(&message_erreur(&e), 250));
            vec![]
        }
    }
}

/// Rapproche une liste de **codes centraux** (issus de Qlik) du catalogue FF Nancy.
///
/// C'est l'étape 2 de la recherche produit : Qlik dit quels articles le réseau
/// travaille, cette requête dit lesquels nous référençons — et avec quel
/// `codein`, quel fournisseur et quel stock. Un code absent du résultat est un
/// produit réseau que Nancy ne référence pas (cas normal et intéressant).
///
/// Les codeins sont renvoyés indexés par code centrale ; un même code centrale
/// peut porter plusieurs codeins (ré-créations d'article), on ne garde que le
/// `no_id` le plus récent. Map vide en cas d'erreur.
pub async fn pg_get_produits_by_code_centrale(codes_centraux: &[String]) -> HashMap<String, PgProduitSearchRow> {
    let mut out = HashMap::new();
    let mut seen = HashSet::new();
    let codes: Vec<String> =
        codes_centraux.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty() && seen.insert(c.clone())).collect();
    if codes.is_empty() {
        return out;
    }

    let mut qb = QueryBuilder::<Postgres>::new(
        "
            WITH matched AS (
                SELECT DISTINCT ON (TRIM(a.artcentrale::text))
                    a.no_id,
                    TRIM(a.codein::text)                    AS codein,
                    TRIM(a.artcentrale::text)               AS code_centrale,
                    COALESCE(a.libelle1, '')                AS libelle1,
                    a.nom_no_id
                FROM articles a
                WHERE TRIM(a.artcentrale::text) IN (",
    );
    let mut sep = qb.separated(", ");
    for c in &codes {
        sep.push_bind(c.clone());
    }
    qb.push(
        ")
                  AND a.codein IS NOT NULL
                ORDER BY TRIM(a.artcentrale::text), a.no_id DESC
            )
            SELECT
                m.no_id,
                m.codein,
                m.code_centrale,
                m.libelle1,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur,
                COALESCE(af.code, '')::text                         AS codefou,
                COALESCE(n.code, '')::text                          AS nomenclature_code,
                COALESCE(n.libelle, '')::text                       AS nomenclature,
                COALESCE(st.stock_total, 0)::float                  AS stock_total,
                TRUE                                                AS has_reseau,
                0::float                                            AS qte_reseau,
                0                                                   AS nb_magasins_reseau
            FROM matched m
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = m.no_id
                ORDER BY (af1.preference = 1) DESC NULLS LAST, af1.no_id DESC
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            LEFT JOIN nomenclature n ON n.no_id = m.nom_no_id
            LEFT JOIN LATERAL (
                SELECT SUM(cs.qte)::float AS stock_total
                FROM cube_stock cs
                WHERE cs.artnoid = m.no_id AND cs.site IN ('292', '579')
            ) st ON TRUE
        ",
    );

    let res = async { anyhow::Ok(qb.build().fetch_all(&pool()?).await?) }.await;
    match res {
        Ok(rows) => {
            for r in &rows {
                let row = produit_search_row(r);
                out.insert(row.code_centrale.clone(), row);
            }
            tracing::info!(
                "[pg-ff] pgGetProduitsByCodeCentrale: {} codes Qlik → {} trouvés dans le catalogue Nancy",
                codes.len(),
                out.len()
            );
            out
        }
        Err(e) => {
            tracing::error!("[pg-ff] pgGetProduitsByCodeCentrale error: {}", short(&message_erreur(&e), 250));
            out
        }
    }
}

/// `codein` de l'article portant ce code centrale, ou `None` si Nancy ne le
/// référence pas. Utilisé par la fiche produit ouverte depuis un résultat Qlik
/// (URL `?cc=…`), qui n'a que le code centrale. `None` en cas d'erreur.
pub async fn pg_get_codein_by_code_centrale(code_centrale: &str) -> Option<String> {
    let cleaned = code_centrale.trim();
    if cleaned.is_empty() {
        return None;
    }
    let res = async {
        let rows = sqlx::query(
            r#"
            SELECT TRIM(a.codein::text) AS codein
            FROM articles a
            WHERE TRIM(a.artcentrale::text) = $1
              AND a.codein IS NOT NULL
            ORDER BY a.no_id DESC
            LIMIT 1
        "#,
        )
        .bind(cleaned)
        .fetch_all(&pool()?)
        .await?;
        anyhow::Ok(rows.first().and_then(|r| os(r, "codein")))
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetCodeinByCodeCentrale error: {}", short(&message_erreur(&e), 250));
            None
        }
    }
}

/// Identité, prix et nomenclature d'un produit (une seule ligne).
#[derive(Debug, Clone, Default, Serialize)]
pub struct PgProduitDetailRow {
    pub no_id: i64,
    pub codein: String,
    pub code_centrale: String,
    pub libelle1: String,
    pub nom_no_id: Option<i64>,
    pub gtin: String,
    pub reference: String,
    pub pcb: Option<f64>,
    /// article_infosup.prix_vente_mini
    pub pv_central: Option<f64>,
    /// cube_pa.pa
    pub pa: Option<f64>,
    pub code3: Option<String>,
    pub libelle3: Option<String>,
    pub code2: Option<String>,
    pub libelle2: Option<String>,
    pub code1: Option<String>,
    pub libelle1nom: Option<String>,
}

/// Fiche d'identité complète d'un produit à partir de son `codein`.
/// Renvoie `None` si le codein est inconnu (ou en cas d'erreur).
pub async fn pg_get_produit_detail(codein: &str) -> Option<PgProduitDetailRow> {
    let res = async {
        let parent_col = get_nomenclature_parent_col().await?;
        // Hiérarchie nomenclature — deux stratégies :
        //
        //  1. Colonne parent entière si elle existe (FK vers le no_id du niveau au-dessus).
        //  2. Sinon, remontée par **préfixe de code** : la nomenclature FF est encodée
        //     hiérarchiquement, secteur = 2 chiffres, famille = 4, sous-famille = 6
        //     (ex "330702" → "3307" → "33"). En production `nomenclature` n'expose que
        //     no_id / code / libelle / niveau / chemin_pere : aucune FK entière, et
        //     `chemin_pere` est un chemin texte. Sans ce repli, Secteur et Famille
        //     restaient vides sur la fiche.
        let hierarchy = match parent_col.as_deref() {
            Some(pc) => {
                let pc = quote_ident(pc);
                format!(
                    "
            LEFT JOIN nomenclature n2 ON n2.no_id = n3.{pc}
            LEFT JOIN nomenclature n1 ON n1.no_id = n2.{pc}
        "
                )
            }
            None => "
            LEFT JOIN LATERAL (
                SELECT nx.code, nx.libelle
                FROM nomenclature nx
                WHERE LENGTH(TRIM(n3.code)) >= 4
                  AND TRIM(nx.code) = LEFT(TRIM(n3.code), 4)
                LIMIT 1
            ) n2 ON TRUE
            LEFT JOIN LATERAL (
                SELECT nx.code, nx.libelle
                FROM nomenclature nx
                WHERE LENGTH(TRIM(n3.code)) >= 2
                  AND TRIM(nx.code) = LEFT(TRIM(n3.code), 2)
                LIMIT 1
            ) n1 ON TRUE
        "
            .to_string(),
        };
        // Les colonnes sont identiques dans les deux stratégies (alias n1 / n2).
        let hierarchy_cols = ",
            n2.code    AS code2,
            n2.libelle AS libelle2,
            n1.code    AS code1,
            n1.libelle AS libelle1nom";

        let sql = format!(
            r#"
            SELECT
                a.no_id,
                TRIM(a.codein::text)                    AS codein,
                COALESCE(TRIM(a.artcentrale::text), '') AS code_centrale,
                COALESCE(a.libelle1, '')                AS libelle1,
                a.nom_no_id,
                COALESCE(ag.gtin, af.ean13, '')::text   AS gtin,
                COALESCE(af.reference, '')::text        AS reference,
                af.pcb::float                           AS pcb,
                ai.prix_vente_mini::float               AS pv_central,
                pa.pa::float                            AS pa,
                n3.code                                 AS code3,
                n3.libelle                              AS libelle3
                {hierarchy_cols}
            FROM articles a
            LEFT JOIN LATERAL (
                SELECT af1.code, af1.pcb, af1.reference, af1.ean13
                FROM artfou1 af1
                WHERE af1.art_no_id = a.no_id
                ORDER BY af1.preference DESC NULLS LAST, af1.no_id DESC
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN art_gtin ag         ON ag.idarticle = a.no_id AND ag.preferentiel = 1
            LEFT JOIN article_infosup ai  ON ai.artnoid = a.no_id
            LEFT JOIN cube_pa pa          ON pa.artnoid = a.no_id
            LEFT JOIN nomenclature n3     ON n3.no_id = a.nom_no_id
            {hierarchy}
            WHERE TRIM(a.codein::text) = $1
            ORDER BY a.no_id DESC
            LIMIT 1
        "#
        );
        let rows = sqlx::query(&sql).bind(codein).fetch_all(&pool()?).await?;
        anyhow::Ok(rows.first().map(|r| PgProduitDetailRow {
            no_id: oi(r, "no_id").unwrap_or(0),
            codein: s(r, "codein"),
            code_centrale: s(r, "code_centrale"),
            libelle1: s(r, "libelle1"),
            nom_no_id: oi(r, "nom_no_id"),
            gtin: s(r, "gtin"),
            reference: s(r, "reference"),
            pcb: of(r, "pcb"),
            pv_central: of(r, "pv_central"),
            pa: of(r, "pa"),
            code3: os(r, "code3"),
            libelle3: os(r, "libelle3"),
            code2: os(r, "code2"),
            libelle2: os(r, "libelle2"),
            code1: os(r, "code1"),
            libelle1nom: os(r, "libelle1nom"),
        }))
    }
    .await;
    match res {
        Ok(row) => {
            tracing::info!("[pg-ff] pgGetProduitDetail({codein}): {}", if row.is_some() { "trouvé" } else { "introuvable" });
            row
        }
        Err(e) => {
            tracing::error!("[pg-ff] pgGetProduitDetail error: {}", short(&message_erreur(&e), 250));
            None
        }
    }
}

/// Un fournisseur référencé pour l'article.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PgProduitFournisseurRow {
    pub codefou: String,
    pub nomfou: String,
    pub reference: String,
    pub pcb: Option<f64>,
    /// true si artfou1.preference = 1 (`null` si la préférence est vide)
    pub principal: Option<bool>,
}

/// Tous les fournisseurs référencés pour un article (le principal en premier).
/// Liste vide en cas d'erreur.
pub async fn pg_get_fournisseurs_by_codein(codein: &str) -> Vec<PgProduitFournisseurRow> {
    let res = async {
        let rows = sqlx::query(
            r#"
            SELECT DISTINCT ON (af.code)
                af.code::text                        AS codefou,
                COALESCE(fi.nom, af.code)::text      AS nomfou,
                COALESCE(af.reference, '')::text     AS reference,
                af.pcb::float                        AS pcb,
                (af.preference = 1)                  AS principal
            FROM articles a
            JOIN artfou1 af ON af.art_no_id = a.no_id
            LEFT JOIN fouident fi ON fi.code = af.code
            WHERE TRIM(a.codein::text) = $1
            ORDER BY af.code, af.preference DESC NULLS LAST, af.no_id DESC
        "#,
        )
        .bind(codein)
        .fetch_all(&pool()?)
        .await?;
        let mut rows: Vec<PgProduitFournisseurRow> = rows
            .iter()
            .map(|r| PgProduitFournisseurRow {
                codefou: s(r, "codefou"),
                nomfou: s(r, "nomfou"),
                reference: s(r, "reference"),
                pcb: of(r, "pcb"),
                principal: ob(r, "principal"),
            })
            .collect();
        // Le principal remonte en tête (le DISTINCT ON impose un tri par code).
        let p = |x: &PgProduitFournisseurRow| if x.principal == Some(true) { 1 } else { 0 };
        rows.sort_by(|x, y| p(y).cmp(&p(x)).then_with(|| compare_fr(&x.nomfou, &y.nomfou)));
        anyhow::Ok(rows)
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetFournisseursByCodein error: {}", short(&message_erreur(&e), 250));
            vec![]
        }
    }
}

/// Stock temps réel par site pour un article.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PgProduitStockRow {
    pub site: String,
    pub stockdispo: f64,
    pub qte: f64,
    pub valstock: f64,
    pub prmp: f64,
    pub dernierevente: Option<String>,
    pub dernierereception: Option<String>,
}

/// Stock par site d'un article. Liste vide en cas d'erreur.
pub async fn pg_get_stock_by_codein(codein: &str) -> Vec<PgProduitStockRow> {
    let res = async {
        let rows = sqlx::query(
            r#"
            SELECT
                cs.site,
                COALESCE(cs.stockdispo, 0)::float AS stockdispo,
                COALESCE(cs.qte, 0)::float        AS qte,
                COALESCE(cs.valstock, 0)::float   AS valstock,
                COALESCE(cs.prmp, 0)::float       AS prmp,
                cs.dernierevente::text            AS dernierevente,
                cs.dernierereception::text        AS dernierereception
            FROM cube_stock cs
            JOIN articles a ON a.no_id = cs.artnoid
            WHERE TRIM(a.codein::text) = $1
              AND cs.site IN ('292', '579')
            ORDER BY cs.site
        "#,
        )
        .bind(codein)
        .fetch_all(&pool()?)
        .await?;
        anyhow::Ok(
            rows.iter()
                .map(|r| PgProduitStockRow {
                    site: s(r, "site"),
                    stockdispo: f(r, "stockdispo"),
                    qte: f(r, "qte"),
                    valstock: f(r, "valstock"),
                    prmp: f(r, "prmp"),
                    dernierevente: os(r, "dernierevente"),
                    dernierereception: os(r, "dernierereception"),
                })
                .collect(),
        )
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetStockByCodein error: {}", short(&message_erreur(&e), 250));
            vec![]
        }
    }
}

/// Quantité totale en commande fournisseur pour un article (0 en cas d'erreur).
pub async fn pg_get_commandes_by_codein(codein: &str) -> f64 {
    let res = async {
        let rows = sqlx::query(
            r#"
            SELECT COALESCE(SUM(cv.cdefou_ligne_qtecde), 0)::float AS qtecde
            FROM cdefou_vivant cv
            WHERE TRIM(cv.articles_codein::text) = $1
        "#,
        )
        .bind(codein)
        .fetch_all(&pool()?)
        .await?;
        anyhow::Ok(rows.first().map(|r| f(r, "qtecde")).unwrap_or(0.0))
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetCommandesByCodein error: {}", short(&message_erreur(&e), 250));
            0.0
        }
    }
}

/// Une gamme affectée à l'article pour une saison donnée.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PgGammeHistoryRow {
    pub saison_no_id: i64,
    pub saison_code: Option<String>,
    pub saison_libelle: Option<String>,
    pub gamme_code: String,
    pub gamme_libelle: Option<String>,
}

/// Historique complet des gammes de l'article, saison par saison (la plus
/// récente en premier). Le reste de l'application ne lit que la saison active
/// (`pg_get_gammes_by_fournisseur`) ; ici on veut la trajectoire d'arbitrage.
/// Liste vide en cas d'erreur.
pub async fn pg_get_gamme_history_by_codein(codein: &str) -> Vec<PgGammeHistoryRow> {
    let res = async {
        let rows = sqlx::query(
            r#"
            SELECT
                s.no_id            AS saison_no_id,
                s.code::text       AS saison_code,
                s.libelle::text    AS saison_libelle,
                g.code::text       AS gamme_code,
                g.libelle::text    AS gamme_libelle
            FROM art_gamme_saison ags
            JOIN articles a ON a.no_id = ags.artnoid
            JOIN gammes g   ON g.no_id = ags.idgamme
            JOIN saisons s  ON s.no_id = ags.idsaison
            WHERE TRIM(a.codein::text) = $1
            ORDER BY s.no_id DESC
        "#,
        )
        .bind(codein)
        .fetch_all(&pool()?)
        .await?;
        anyhow::Ok(
            rows.iter()
                .map(|r| PgGammeHistoryRow {
                    saison_no_id: oi(r, "saison_no_id").unwrap_or(0),
                    saison_code: os(r, "saison_code"),
                    saison_libelle: os(r, "saison_libelle"),
                    gamme_code: s(r, "gamme_code"),
                    gamme_libelle: os(r, "gamme_libelle"),
                })
                .collect(),
        )
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[pg-ff] pgGetGammeHistoryByCodein error: {}", short(&message_erreur(&e), 250));
            vec![]
        }
    }
}

/// Données mensuelles (ventes / CA / marge / stock fin de mois / réceptions)
/// d'UN article, par site et par mois.
///
/// Reprend **exactement** le calcul canonique de `pg_get_mensuel_by_fournisseur`
/// (la source de vérité de la Grille) : seule la sélection change — filtre sur
/// le codein au lieu d'une jointure `artfou1`. Les chiffres affichés sur la
/// fiche produit sont donc identiques à ceux de la Grille, par construction.
/// Liste vide en cas d'erreur.
pub async fn pg_get_mensuel_by_codein(codein: &str, date_debut: &str, date_fin: &str) -> Vec<PgMensuelRow> {
    let res = async {
        let rows = sqlx::query(
            r#"
            WITH base AS (
                SELECT
                    TRIM(a.codein::text)          AS codein,
                    m.site,
                    TO_CHAR(m.datmvt, 'YYYY-MM')  AS mois,
                    m.qtemvt,
                    m.mntmvtttc,
                    m.margemvt,
                    m.genremvt,
                    m.qtestock,
                    ROW_NUMBER() OVER (
                        PARTITION BY m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
                        ORDER BY m.datmvt DESC
                    ) AS rn_last
                FROM mvtart m
                JOIN articles a ON a.no_id = m.artnoid
                WHERE TRIM(a.codein::text) = $1
                  AND m.datmvt BETWEEN $2::date AND $3::date
                  AND m.site IN ('292', '579')
            )
            SELECT
                codein,
                site,
                mois,
                SUM(CASE WHEN genremvt = 3 THEN -qtemvt    ELSE 0 END)::float     AS qte_vendue,
                SUM(CASE WHEN genremvt = 3 THEN -mntmvtttc ELSE 0 END)::float     AS ca_ht,
                SUM(CASE WHEN genremvt = 3 THEN  margemvt  ELSE 0 END)::float     AS marge,
                MAX(CASE WHEN rn_last = 1 THEN qtestock ELSE NULL END)::float     AS stock_fin_mois,
                SUM(CASE WHEN genremvt IN (1, 2) THEN qtemvt ELSE 0 END)::float   AS qte_recue
            FROM base
            GROUP BY codein, site, mois
            ORDER BY site, mois
        "#,
        )
        .bind(codein)
        .bind(date_debut)
        .bind(date_fin)
        .fetch_all(&pool()?)
        .await?;
        anyhow::Ok(rows.iter().map(mensuel_row).collect::<Vec<_>>())
    }
    .await;
    match res {
        Ok(v) => {
            tracing::info!("[pg-ff] pgGetMensuelByCodein({codein}): {} lignes", v.len());
            v
        }
        Err(e) => {
            tracing::error!("[pg-ff] pgGetMensuelByCodein error: {}", short(&message_erreur(&e), 250));
            vec![]
        }
    }
}

/// Un produit de la même famille, comparé local vs réseau.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PgOpportuniteRow {
    pub codein: String,
    pub libelle1: String,
    pub code_centrale: String,
    pub fournisseur: String,
    pub qte_reseau: f64,
    pub nb_magasins_reseau: f64,
    pub ca_reseau: f64,
    pub ca_par_magasin_reseau: f64,
    pub qte_locale: f64,
    pub nb_sites_locaux: f64,
    pub qte_reseau_par_magasin: f64,
    pub qte_locale_par_magasin: f64,
    /// Écart réseau − local, par magasin, sur 12 mois. Positif = opportunité.
    pub ecart_par_magasin: f64,
}

/// Produits de la même nomenclature, classés par écart entre la performance
/// réseau et la performance locale (quantités **par magasin**, pour neutraliser
/// la différence d'échelle entre ~270 magasins et nos 2 sites).
///
/// Périmètre volontairement borné aux articles **de notre catalogue** ayant déjà
/// des métriques réseau en cache : la dimension Qlik interrogée est
/// `Article Code`, on ne peut pas découvrir un produit que Nancy ne référence pas.
///
/// `limit` : 30 dans le code d'origine. Liste vide en cas d'erreur.
pub async fn pg_get_opportunites_famille(nom_no_id: i64, date_debut: &str, date_fin: &str, limit: i64) -> Vec<PgOpportuniteRow> {
    let res = async {
        let rows = sqlx::query(
            r#"
            WITH famille AS (
                SELECT DISTINCT ON (TRIM(a.codein::text))
                    a.no_id,
                    TRIM(a.codein::text)      AS codein,
                    TRIM(a.artcentrale::text) AS code_centrale,
                    COALESCE(a.libelle1, '')  AS libelle1
                FROM articles a
                WHERE a.nom_no_id = $1
                  AND a.codein IS NOT NULL
                  AND a.artcentrale IS NOT NULL
                  AND TRIM(a.artcentrale::text) <> ''
                ORDER BY TRIM(a.codein::text), a.no_id DESC
            ),
            avec_reseau AS (
                SELECT
                    f.no_id,
                    f.codein,
                    f.code_centrale,
                    f.libelle1,
                    q.qte_reseau::float             AS qte_reseau,
                    q.nb_magasins_reseau            AS nb_magasins_reseau,
                    COALESCE(q.ca_reseau, 0)::float AS ca_reseau,
                    COALESCE(q.ca_par_magasin_reseau, 0)::float AS ca_par_magasin_reseau
                FROM famille f
                JOIN qlik_network_metrics q ON q.code_centrale = f.code_centrale
                WHERE q.nb_magasins_reseau > 0
                  AND q.qte_reseau > 0
            ),
            ventes AS (
                SELECT
                    TRIM(a.codein::text)      AS codein,
                    SUM(-m.qtemvt)::float     AS qte_locale,
                    COUNT(DISTINCT m.site)    AS nb_sites_locaux
                FROM mvtart m
                JOIN articles a ON a.no_id = m.artnoid
                WHERE m.genremvt = 3
                  AND m.site IN ('292', '579')
                  AND m.datmvt BETWEEN $2::date AND $3::date
                  AND TRIM(a.codein::text) IN (SELECT codein FROM avec_reseau)
                GROUP BY TRIM(a.codein::text)
            )
            SELECT
                r.codein,
                r.libelle1,
                r.code_centrale,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur,
                r.qte_reseau,
                r.nb_magasins_reseau,
                r.ca_reseau,
                r.ca_par_magasin_reseau,
                COALESCE(v.qte_locale, 0)::float   AS qte_locale,
                COALESCE(v.nb_sites_locaux, 0)     AS nb_sites_locaux,
                (r.qte_reseau / r.nb_magasins_reseau)::float AS qte_reseau_par_magasin,
                (COALESCE(v.qte_locale, 0) / GREATEST(COALESCE(v.nb_sites_locaux, 0), 1))::float AS qte_locale_par_magasin,
                (
                    (r.qte_reseau / r.nb_magasins_reseau)
                    - (COALESCE(v.qte_locale, 0) / GREATEST(COALESCE(v.nb_sites_locaux, 0), 1))
                )::float AS ecart_par_magasin
            FROM avec_reseau r
            LEFT JOIN ventes v ON v.codein = r.codein
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = r.no_id
                ORDER BY (af1.preference = 1) DESC NULLS LAST, af1.no_id DESC
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            ORDER BY ecart_par_magasin DESC
            LIMIT $4
        "#,
        )
        .bind(nom_no_id)
        .bind(date_debut)
        .bind(date_fin)
        .bind(limit)
        .fetch_all(&pool()?)
        .await?;
        anyhow::Ok(
            rows.iter()
                .map(|r| PgOpportuniteRow {
                    codein: s(r, "codein"),
                    libelle1: s(r, "libelle1"),
                    code_centrale: s(r, "code_centrale"),
                    fournisseur: s(r, "fournisseur"),
                    qte_reseau: f(r, "qte_reseau"),
                    nb_magasins_reseau: f(r, "nb_magasins_reseau"),
                    ca_reseau: f(r, "ca_reseau"),
                    ca_par_magasin_reseau: f(r, "ca_par_magasin_reseau"),
                    qte_locale: f(r, "qte_locale"),
                    nb_sites_locaux: f(r, "nb_sites_locaux"),
                    qte_reseau_par_magasin: f(r, "qte_reseau_par_magasin"),
                    qte_locale_par_magasin: f(r, "qte_locale_par_magasin"),
                    ecart_par_magasin: f(r, "ecart_par_magasin"),
                })
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match res {
        Ok(v) => {
            tracing::info!("[pg-ff] pgGetOpportunitesFamille(nom={nom_no_id}): {} lignes", v.len());
            v
        }
        Err(e) => {
            tracing::error!("[pg-ff] pgGetOpportunitesFamille error: {}", short(&message_erreur(&e), 250));
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bornes() {
        assert_eq!(bornes_mois("2026-03"), ("2026-03-01".into(), "2026-04-01".into()));
        assert_eq!(bornes_mois("2025-12"), ("2025-12-01".into(), "2026-01-01".into()));
        assert_eq!(bornes_mois("2025-09"), ("2025-09-01".into(), "2025-10-01".into()));
    }

    #[test]
    fn normalisation_recherche() {
        assert_eq!(normalize_search_term("Tapis anti-POUSSIÈRE !"), "tapis anti poussiere");
        assert_eq!(normalize_search_term("  Crème brûlée  "), "creme brulee");
        assert_eq!(SQL_ACCENTS_FROM.chars().count(), SQL_ACCENTS_TO.chars().count());
    }

    #[test]
    fn tri_fr() {
        let mut v = vec!["Zèbre", "école", "Abeille", "Éclair"];
        v.sort_by(|a, b| compare_fr(a, b));
        assert_eq!(v, vec!["Abeille", "Éclair", "école", "Zèbre"]);
    }

    #[test]
    fn commande_auto_mapping() {
        let r = json!({ "site": 292, "codefou": "N009", "nom_fou": "X", "franco_ht": "150.5", "nb_articles": 3,
                        "montant_propo_ht": null, "montant_cde": "12", "franco_atteint": "NON", "ecart_franco": -3 });
        let m = map_commande_auto_row(&r);
        assert_eq!(m.site, "292");
        assert_eq!(m.franco, 150.5);
        assert_eq!(m.montant_cde, 12.0);
        assert_eq!(m.franco_atteint, Some(false));
        assert_eq!(extract_franco(&json!({ "resume": [{ "franco_ht": "200" }] })), 200.0);
        assert_eq!(extract_franco(&json!({ "error": "x" })), 0.0);
        assert_eq!(extract_franco(&json!({ "resume": [] })), 0.0);
    }
}
