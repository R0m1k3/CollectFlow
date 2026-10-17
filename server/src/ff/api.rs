//! CollectFlow — client de l'API FF Nancy (port de `src/lib/api-ff-client.ts`).
//!
//! Client HTTP centralisé pour l'API REST https://api.ffnancy.fr
//! Sync nuit SQL Server → données fraîches J-1
//!
//! Stratégie mouvements : appeler SANS filtre genremvt (tous types)
//!   - genremvt = 3 → alimenter sales12m (ventes)
//!   - Tous types → lire qtestock pour reconstruire stock12m

use super::js::{coalesce, encode, get, js_number, js_number_or0, js_string, message_erreur, opt_string, truthy};
use chrono::{Datelike, Local, NaiveDate};
use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant};

pub const FF_API_BASE_DEFAULT: &str = "https://api.ffnancy.fr";
const FF_API_BASE_TTL: Duration = Duration::from_secs(30);

/// Délai maximal d'un appel à l'API FF (`FF_API_TIMEOUT_MS`, 30 s par défaut).
/// Sans délai, une API muette figeait indéfiniment la page qui l'attendait.
pub fn ff_fetch_timeout() -> Duration {
    let ms = std::env::var("FF_API_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(30_000.0);
    Duration::from_millis(ms as u64)
}

/// Client HTTP de tout appel à l'API FF (équivalent de `ffFetchInit()`) :
/// jamais de cache HTTP, et un délai maximal.
pub fn ff_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(ff_fetch_timeout())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// `fetch(url, ffFetchInit())`, clé d'API comprise.
pub async fn ff_get(url: &str) -> reqwest::Result<reqwest::Response> {
    avec_cle_ff(ff_client().get(url).header(reqwest::header::CACHE_CONTROL, "no-store")).await.send().await
}

/// En-tête d'authentification attendu par l'API FF Nancy.
pub const FF_API_KEY_HEADER: &str = "X-API-Key";

/// Ajoute la clé d'API enregistrée (en-tête `X-API-Key`) à une requête vers l'API FF.
/// Sans clé configurée, la requête part telle quelle.
pub async fn avec_cle_ff(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match get_ff_api_key().await {
        Some(cle) => req.header(FF_API_KEY_HEADER, cle),
        None => req,
    }
}

/// Libellé HTTP d'un statut (équivalent de `res.statusText`).
pub fn status_text(status: reqwest::StatusCode) -> &'static str {
    status.canonical_reason().unwrap_or("")
}

/// Réglages de connexion à l'API FF résolus : adresse et clé.
#[derive(Clone)]
struct FfApiReglages {
    base: String,
    cle: Option<String>,
}

static FF_API_CACHE: LazyLock<Mutex<Option<(FfApiReglages, Instant)>>> = LazyLock::new(|| Mutex::new(None));

/// Chaîne non vide après `trim`, sinon `None`.
fn non_vide(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Clé d'API FF : réglage enregistré dans Paramètres → variable d'environnement
/// `FF_API_KEY` → aucune.
pub fn resoudre_ff_api_key(configured: Option<String>) -> Option<String> {
    non_vide(configured).or_else(|| non_vide(std::env::var("FF_API_KEY").ok()))
}

async fn get_ff_api_reglages() -> FfApiReglages {
    if let Some((value, at)) = FF_API_CACHE.lock().as_ref() {
        if at.elapsed() < FF_API_BASE_TTL {
            return value.clone();
        }
    }
    // Fichier absent ou illisible : on retombe sur l'environnement.
    let config = tokio::task::spawn_blocking(crate::config::read_config).await.unwrap_or_default();
    let base = non_vide(config.ff_api_base_url)
        .or_else(|| non_vide(std::env::var("FF_API_BASE_URL").ok()))
        .unwrap_or_else(|| FF_API_BASE_DEFAULT.to_string())
        .trim_end_matches('/')
        .to_string();
    let value = FfApiReglages { base, cle: resoudre_ff_api_key(config.ff_api_key) };
    *FF_API_CACHE.lock() = Some((value.clone(), Instant::now()));
    value
}

/// URL de l'API FF Nancy, résolue **au moment de l'appel**.
///
/// Ordre de priorité : réglage enregistré dans Paramètres → variable
/// d'environnement `FF_API_BASE_URL` → valeur par défaut. Auparavant l'URL était
/// figée au chargement du module depuis l'environnement seul : impossible de la
/// corriger depuis l'application quand le serveur changeait d'adresse.
///
/// Le résultat est mémorisé 30 s pour ne pas relire le fichier à chaque requête.
pub async fn get_ff_api_base() -> String {
    get_ff_api_reglages().await.base
}

/// Clé d'API FF Nancy (même cache que l'adresse).
pub async fn get_ff_api_key() -> Option<String> {
    get_ff_api_reglages().await.cle
}

/// Vide le cache — appelé après un enregistrement dans Paramètres.
pub fn reset_ff_api_base_cache() {
    *FF_API_CACHE.lock() = None;
}

// ---------------------------------------------------------------------------
// Types API (shapes des réponses brutes)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfFournisseur {
    pub codefou: String,
    pub nomfou: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfArticle {
    pub codein: String,
    pub libelle1: String,
    pub codefou: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nomfou: Option<String>,
    /// conditionnement
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pcb: Option<f64>,
    /// prix de vente central
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pv_central: Option<f64>,
    /// SQL Server internal ID (pour endpoint /mensuel)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noid: Option<i64>,
    /// référence fournisseur (ref_fou_principale)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// code-barres EAN/GTIN
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gtin: Option<String>,
    /// article actif
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actif: Option<bool>,
    /// article suspendu
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspendu: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfMouvement {
    pub codein: String,
    /// 3 = vente client
    pub genremvt: f64,
    /// ISO date (YYYY-MM-DD)
    pub datemvt: String,
    pub qte: f64,
    /// montant HT
    pub montant: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marge: Option<f64>,
    /// stock APRÈS ce mouvement — clé pour stock12m
    pub qtestock: f64,
    pub site: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codefou_reel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nom_fournisseur_reel: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfStock {
    pub codein: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    pub stockdispo: f64,
    pub qte: f64,
    pub valstock: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prmp: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pv: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dernieresventes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dernierereception: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nbjoursdernsventes: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfCommande {
    pub codein: String,
    pub qtecde: f64,
}

/// Une table de `/api/sync/status`, forme normalisée.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfSyncTable {
    pub nom: String,
    pub derniere_sync: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nb_lignes: Option<f64>,
    /// "ok" ou état d'erreur renvoyé par la synchronisation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statut: Option<String>,
    #[serde(default)]
    pub erreur: Option<String>,
}

/// Statut de synchronisation. `tables` reste en JSON brut : la forme déjà
/// attendue (`{ lastSync, tables }`) était renvoyée telle quelle par le TS.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfSyncStatus {
    pub last_sync: String,
    pub tables: Vec<Value>,
}

/// Normalise la réponse de `/api/sync/status`.
///
/// L'API renvoie `{ sync: [{ table_name, last_sync, rows_synced, status, error_msg }] }`,
/// alors que l'application attendait `{ lastSync, tables: [{ nom, derniereSync, nbLignes }] }`.
/// Les champs lus n'existaient donc pas : le panneau des Paramètres affichait une
/// coquille vide sans la moindre erreur, puisque la requête HTTP réussissait.
///
/// Les deux formes sont acceptées ici, pour rester compatible si l'API évolue.
pub fn normalize_sync_status(raw: &Value) -> Option<FfSyncStatus> {
    let d = raw.as_object()?;

    // Forme déjà attendue par l'application.
    if let Some(Value::Array(tables)) = d.get("tables") {
        let last = d.get("lastSync").filter(|v| !v.is_null()).map(js_string).unwrap_or_default();
        return Some(FfSyncStatus { last_sync: last, tables: tables.clone() });
    }

    // Forme réelle de l'API FF Nancy.
    let sync = match d.get("sync") {
        Some(Value::Array(a)) => a,
        _ => return None,
    };

    let tables: Vec<FfSyncTable> = sync
        .iter()
        .map(|t| FfSyncTable {
            nom: coalesce(t, &["table_name", "nom"]).map(js_string).unwrap_or_else(|| "—".into()),
            derniere_sync: coalesce(t, &["last_sync", "derniereSync"]).map(js_string).unwrap_or_default(),
            nb_lignes: Some(coalesce(t, &["rows_synced", "nbLignes"]).map(js_number_or0).unwrap_or(0.0)),
            statut: get(t, "status").filter(|v| !v.is_null()).map(js_string),
            erreur: get(t, "error_msg").filter(|v| !v.is_null()).map(js_string),
        })
        .collect();

    // Pas de date globale dans la réponse : on prend la plus récente des tables.
    let mut dates: Vec<&String> = tables.iter().map(|t| &t.derniere_sync).filter(|s| !s.is_empty()).collect();
    dates.sort();
    let last_sync = dates.last().map(|s| s.to_string()).unwrap_or_default();

    let tables = tables.into_iter().map(|t| serde_json::to_value(t).unwrap_or(Value::Null)).collect();
    Some(FfSyncStatus { last_sync, tables })
}

/// Stock agrégé sur tous les sites pour un codein
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregatedStock {
    /// sum stockdispo
    pub stock_actuel: f64,
    /// sum qte
    pub stock_total: f64,
    /// sum valstock
    pub stock_valeur: f64,
    /// prmp (premier site non-zéro)
    pub pa: f64,
    /// pv premier site
    pub prix_vente: f64,
    /// max date tous sites
    pub derniere_vente: String,
    /// max dernierereception tous sites
    pub derniere_livraison: String,
    /// min tous sites
    pub nb_jours_derniere_vente: f64,
}

// ---------------------------------------------------------------------------
// Pagination générique
// ---------------------------------------------------------------------------

/// Liste contenue dans une réponse : tableau direct, ou enveloppe courante.
pub fn extract_list(data: &Value) -> Vec<Value> {
    if let Value::Array(a) = data {
        return a.clone();
    }
    let Some(d) = data.as_object() else { return vec![] };
    // Essaie les wrappers courants
    for key in [
        "items", "data", "result", "results", "records", "list", "mouvements", "articles", "fournisseurs", "ventes", "stocks",
        "commandes",
    ] {
        if let Some(Value::Array(a)) = d.get(key) {
            return a.clone();
        }
    }
    // Cherche la première propriété qui est un tableau
    for val in d.values() {
        if let Value::Array(a) = val {
            return a.clone();
        }
    }
    vec![]
}

fn first_keys(items: &[Value]) -> String {
    match items.first().and_then(|v| v.as_object()) {
        Some(o) => o.keys().cloned().collect::<Vec<_>>().join(","),
        None => {
            if items.is_empty() {
                "empty".into()
            } else {
                String::new()
            }
        }
    }
}

async fn fetch_json(url: &str) -> anyhow::Result<Option<Value>> {
    let res = ff_get(url).await?;
    if !res.status().is_success() {
        return Ok(None);
    }
    Ok(Some(res.json::<Value>().await?))
}

/// Toutes les pages d'une liste paginée. Une erreur réseau est propagée ; une
/// réponse HTTP en échec donne une page vide.
pub async fn fetch_all_pages(build_url: impl Fn(u32) -> String, page_size: usize) -> anyhow::Result<Vec<Value>> {
    // Page 1 — récupère les items et tente d'obtenir le total pour paralléliser
    let url1 = build_url(1);
    tracing::info!("[api-ff] GET {url1}");
    let res1 = ff_get(&url1).await?;
    if !res1.status().is_success() {
        tracing::error!("[api-ff] HTTP {} — {url1}", res1.status().as_u16());
        return Ok(vec![]);
    }
    let data1: Value = res1.json().await?;
    let items1 = extract_list(&data1);
    tracing::info!("[api-ff] page 1: {} items, keys: {}", items1.len(), first_keys(&items1));

    // Si la première page est incomplète, pas besoin de continuer
    if items1.len() < page_size {
        return Ok(items1);
    }

    // Cherche un total dans la réponse pour paralléliser les pages suivantes
    let total = js_number(coalesce(&data1, &["count", "total", "nb_total", "totalCount"]).unwrap_or(&json!(0)));

    if total > page_size as f64 {
        let total_pages = (total / page_size as f64).ceil() as u32;
        let remaining: Vec<u32> = (2..=total_pages).collect();
        // Fetch en chunks de 10 pages en parallèle
        let mut all = items1;
        for chunk in remaining.chunks(10) {
            let results = futures::future::try_join_all(chunk.iter().map(|&p| {
                let url = build_url(p);
                async move {
                    tracing::info!("[api-ff] GET {url}");
                    anyhow::Ok(fetch_json(&url).await?.map(|d| extract_list(&d)).unwrap_or_default())
                }
            }))
            .await?;
            for r in results {
                all.extend(r);
            }
        }
        return Ok(all);
    }

    // Fallback parallèle sans total : fetch 10 pages à la fois, arrêt dès qu'une page est incomplète
    let mut all = items1;
    let mut start_page = 2u32;
    loop {
        let results = futures::future::try_join_all((0..10).map(|i| {
            let p = start_page + i;
            let url = build_url(p);
            async move {
                tracing::info!("[api-ff] GET {url}");
                anyhow::Ok(fetch_json(&url).await?.map(|d| extract_list(&d)).unwrap_or_default())
            }
        }))
        .await?;
        let mut done = false;
        for items in results {
            let n = items.len();
            all.extend(items);
            if n < page_size {
                done = true;
                break;
            }
        }
        if done {
            break;
        }
        start_page += 10;
    }
    Ok(all)
}

// ---------------------------------------------------------------------------
// Helpers date
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub date_debut: String,
    pub date_fin: String,
}

/// Retourne la fenêtre des 12 mois complets précédant le mois en cours.
/// En mars 2026 → { dateDebut: "2025-03-01", dateFin: "2026-02-28" }
pub fn build_last12_months_range() -> DateRange {
    build_last12_months_range_at(Local::now().date_naive())
}

pub fn build_last12_months_range_at(today: NaiveDate) -> DateRange {
    let first_of_month = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
    // Fin : dernier jour du mois précédent le mois courant
    let end_month = first_of_month.pred_opt().unwrap_or(first_of_month);
    // Début : 12 mois avant le mois courant
    let start_month = first_of_month.checked_sub_months(chrono::Months::new(12)).unwrap_or(first_of_month);
    DateRange {
        date_debut: start_month.format("%Y-%m-%d").to_string(),
        date_fin: end_month.format("%Y-%m-%d").to_string(),
    }
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

fn opt_f64(v: Option<&Value>) -> Option<f64> {
    v.filter(|x| !x.is_null()).map(js_number).filter(|f| !f.is_nan())
}

pub async fn get_articles_by_fournisseur(codefou: &str) -> anyhow::Result<Vec<FfArticle>> {
    let base = get_ff_api_base().await;
    let enc = encode(codefou);
    let raw = fetch_all_pages(|page| format!("{base}/api/articles?codefou={enc}&page={page}&limit=500"), 500).await?;
    Ok(raw
        .iter()
        .map(|r| FfArticle {
            codein: coalesce(r, &["codein", "Codein", "code_article", "codeArticle"])
                .map(js_string)
                .unwrap_or_else(|| get(r, "id").filter(|v| !v.is_null()).map(js_string).unwrap_or_default()),
            libelle1: coalesce(r, &["libelle1", "Libelle1", "libelle", "designation", "nom"]).map(js_string).unwrap_or_default(),
            codefou: coalesce(r, &["codefou_principal", "codefou", "Codefou", "code_fournisseur", "codeFournisseur"])
                .map(js_string)
                .unwrap_or_else(|| codefou.to_string()),
            nomfou: Some(
                coalesce(r, &["nom_fou_principal", "nomfou", "Nomfou", "nom_fournisseur", "nomFournisseur"])
                    .map(js_string)
                    .unwrap_or_default(),
            ),
            pcb: opt_f64(coalesce(r, &["pcb_principal", "pcb", "Pcb", "conditionnement", "colisage"])),
            pv_central: opt_f64(coalesce(r, &["pv_central", "PvCentral", "prix_vente_mini", "pv", "prixVente"])),
            noid: opt_f64(coalesce(r, &["no_id", "noid", "NoId"])).map(|f| f as i64),
            reference: opt_string(coalesce(r, &["ref_fou_principale", "reference", "ref_fournisseur"])),
            gtin: opt_string(coalesce(r, &["gtin", "Gtin", "ean", "barcode"])),
            actif: get(r, "actif").filter(|v| !v.is_null()).map(|v| {
                let n = js_number(v);
                n != 0.0 && !n.is_nan()
            }),
            suspendu: get(r, "suspendu").filter(|v| !v.is_null()).map(|v| {
                let n = js_number(v);
                n != 0.0 && !n.is_nan()
            }),
        })
        .filter(|a| !a.codein.is_empty())
        .collect())
}

// ---------------------------------------------------------------------------
// Mensuel — stock fin de mois + ventes + réceptions par article et par site
// GET /api/articles/:no_id/mensuel?dateDebut=&dateFin=
// ---------------------------------------------------------------------------

/// Chaîne tolérante : un nombre devient sa forme texte, `null` une chaîne vide.
fn de_string_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(if v.is_null() { String::new() } else { js_string(&v) })
}

/// Ventes du mois. Valeurs telles que renvoyées par l'API (chaînes numériques,
/// ex. `"-2.000"`) : lire avec [`super::js::js_number`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfMensuelVentes {
    #[serde(default)]
    pub nb_passages: Value,
    /// négatif (ex: "-2.000")
    #[serde(default)]
    pub qte_vendue: Value,
    /// négatif (ex: "-26.6600")
    #[serde(default)]
    pub ca_ht: Value,
    #[serde(default)]
    pub ca_ttc: Value,
    /// positif (ex: "12.7600")
    #[serde(default)]
    pub marge: Value,
    #[serde(default)]
    pub taux_marge: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfMensuelReceptions {
    #[serde(default)]
    pub nb_receptions: Value,
    #[serde(default)]
    pub qte_recue: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FfMensuelEntry {
    /// "YYYY-MM"
    #[serde(default, deserialize_with = "de_string_lenient")]
    pub mois: String,
    /// code site ("292", "579")
    #[serde(default, deserialize_with = "de_string_lenient")]
    pub site: String,
    /// stock fin de mois
    #[serde(default)]
    pub stock_fin_mois: Value,
    /// PRMP fin de mois
    #[serde(default)]
    pub prmp_fin_mois: Value,
    #[serde(default)]
    pub ventes: Option<FfMensuelVentes>,
    #[serde(default)]
    pub receptions: Option<FfMensuelReceptions>,
    /// Autres champs de la réponse, conservés tels quels.
    #[serde(flatten, default)]
    pub autres: serde_json::Map<String, Value>,
}

/// Récupère les données mensuelles (stock + ventes + réceptions) pour un lot d'articles.
/// Utilise no_id comme identifiant (obligatoire pour l'API).
/// Retourne Map<codein, FfMensuelEntry[]>
pub async fn get_mensuel_by_articles(
    articles: &[FfArticle],
    date_debut: &str,
    date_fin: &str,
    batch_size: usize,
) -> HashMap<String, Vec<FfMensuelEntry>> {
    let mut result = HashMap::new();
    let base = get_ff_api_base().await;

    for batch in articles.chunks(batch_size.max(1)) {
        let found = futures::future::join_all(batch.iter().map(|art| {
            let base = base.clone();
            async move {
                let no_id = art.noid.filter(|n| *n != 0)?;
                let url = format!("{base}/api/articles/{}/mensuel?dateDebut={date_debut}&dateFin={date_fin}", encode(&no_id.to_string()));
                let res = async {
                    let res = ff_get(&url).await?;
                    if !res.status().is_success() {
                        return anyhow::Ok(None);
                    }
                    let data: Value = res.json().await?;
                    let entries: Vec<FfMensuelEntry> = match get(&data, "data") {
                        Some(Value::Array(a)) => a.iter().filter_map(|e| serde_json::from_value(e.clone()).ok()).collect(),
                        _ => vec![],
                    };
                    Ok(Some(entries))
                }
                .await;
                match res {
                    Ok(Some(entries)) if !entries.is_empty() => Some((art.codein.clone(), entries)),
                    Ok(_) => None,
                    Err(err) => {
                        tracing::error!("[api-ff] getMensuel error for {}: {}", art.codein, message_erreur(&err));
                        None
                    }
                }
            }
        }))
        .await;
        result.extend(found.into_iter().flatten());
    }

    result
}

// ---------------------------------------------------------------------------
// Referentiel — article complet : nomenclature, gammes, stock, prix, fournisseurs
// GET /api/articles/:no_id/referentiel
// ---------------------------------------------------------------------------

/// Référentiel complet d'un article, JSON brut de l'API :
/// `{ article: { no_id, codein, nom_code, nom_libelle, nom_niveau, nom_chemin_pere },
///    gammes: [{ gamme_code, gamme_libelle, saison_code, saison_libelle }],
///    stock: [{ site, stockdispo, qte, prmp, valstock, pv, dernierevente, dernierereception, stockmort }],
///    prix: { achat, vente_par_site: [{ site, pv }] } | null,
///    fournisseurs: [{ codefou, ref_fou, pcb, prixachat }],
///    performance: { derniere_vente, derniere_entree, qte_totale_vendue, ca_ttc_total, marge_totale } | null }`
pub type FfReferentiel = Value;

/// Récupère le référentiel complet (nomenclature, gamme, stock, prix) pour un lot d'articles.
/// Utilise no_id comme identifiant.
/// Retourne Map<codein, FfReferentiel>
pub async fn get_referentiel_by_articles(articles: &[FfArticle], batch_size: usize) -> HashMap<String, FfReferentiel> {
    let mut result = HashMap::new();
    let base = get_ff_api_base().await;

    for batch in articles.chunks(batch_size.max(1)) {
        let found = futures::future::join_all(batch.iter().map(|art| {
            let base = base.clone();
            async move {
                let no_id = art.noid.filter(|n| *n != 0)?;
                let url = format!("{base}/api/articles/{}/referentiel", encode(&no_id.to_string()));
                let res = async {
                    let res = ff_get(&url).await?;
                    if !res.status().is_success() {
                        return anyhow::Ok(None);
                    }
                    let data: Value = res.json().await?;
                    Ok(get(&data, "article").filter(|a| truthy(a)).is_some().then_some(data))
                }
                .await;
                match res {
                    Ok(Some(data)) => Some((art.codein.clone(), data)),
                    Ok(None) => None,
                    Err(err) => {
                        tracing::error!("[api-ff] getReferentiel error for {}: {}", art.codein, message_erreur(&err));
                        None
                    }
                }
            }
        }))
        .await;
        result.extend(found.into_iter().flatten());
    }

    result
}

// ---------------------------------------------------------------------------
// Commandes en cours
// ---------------------------------------------------------------------------

pub async fn get_commandes_by_fournisseur(codefou: &str) -> HashMap<String, f64> {
    let mut result: HashMap<String, f64> = HashMap::new();
    let base = get_ff_api_base().await;
    let res = async {
        let res = ff_get(&format!("{base}/api/commandes/articles?codefou={}", encode(codefou))).await?;
        if !res.status().is_success() {
            return anyhow::Ok(());
        }
        let data: Value = res.json().await?;
        let list = if data.is_array() { Some(&data) } else { coalesce(&data, &["items", "data"]) };
        let list = match list {
            None => return Ok(()),
            Some(Value::Array(a)) => a,
            Some(_) => anyhow::bail!("list is not iterable"),
        };
        for c in list {
            let codein = get(c, "codein").map(js_string).unwrap_or_else(|| "undefined".into());
            let qte = get(c, "qtecde").filter(|v| !v.is_null()).map(js_number).unwrap_or(0.0);
            *result.entry(codein).or_insert(0.0) += qte;
        }
        Ok(())
    }
    .await;
    if let Err(err) = res {
        tracing::error!("[api-ff] getCommandesByFournisseur error: {}", message_erreur(&err));
    }
    result
}

// ---------------------------------------------------------------------------
// Sites (magasins)
// ---------------------------------------------------------------------------

pub async fn get_sites_from_api() -> Vec<super::pg::CodeNom> {
    vec![
        super::pg::CodeNom { code: "292".into(), nom: "Frouard (Nancy)".into() },
        super::pg::CodeNom { code: "579".into(), nom: "Houdemont".into() },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last12_range() {
        let r = build_last12_months_range_at(NaiveDate::from_ymd_opt(2026, 3, 15).unwrap());
        assert_eq!(r, DateRange { date_debut: "2025-03-01".into(), date_fin: "2026-02-28".into() });
        let r = build_last12_months_range_at(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap());
        assert_eq!(r, DateRange { date_debut: "2025-01-01".into(), date_fin: "2025-12-31".into() });
    }

    #[test]
    fn sync_status_forms() {
        let api = json!({ "sync": [
            { "table_name": "mvtart", "last_sync": "2026-01-02T03:00:00Z", "rows_synced": "12", "status": "ok", "error_msg": null },
            { "table_name": "articles", "last_sync": "2026-01-03T03:00:00Z", "rows_synced": null, "status": null, "error_msg": "x" }
        ]});
        let s = serde_json::to_value(normalize_sync_status(&api).unwrap()).unwrap();
        assert_eq!(
            s,
            json!({ "lastSync": "2026-01-03T03:00:00Z", "tables": [
                { "nom": "mvtart", "derniereSync": "2026-01-02T03:00:00Z", "nbLignes": 12.0, "statut": "ok", "erreur": null },
                { "nom": "articles", "derniereSync": "2026-01-03T03:00:00Z", "nbLignes": 0.0, "erreur": "x" }
            ]})
        );
        let deja = json!({ "lastSync": "a", "tables": [{ "nom": "t" }] });
        let s = serde_json::to_value(normalize_sync_status(&deja).unwrap()).unwrap();
        assert_eq!(s, json!({ "lastSync": "a", "tables": [{ "nom": "t" }] }));
        assert!(normalize_sync_status(&json!({ "x": 1 })).is_none());
        assert!(normalize_sync_status(&json!(null)).is_none());
    }

    #[test]
    fn extract_list_wrappers() {
        assert_eq!(extract_list(&json!([1, 2])).len(), 2);
        assert_eq!(extract_list(&json!({ "articles": [1] })).len(), 1);
        assert_eq!(extract_list(&json!({ "foo": 1, "bar": [1, 2, 3] })).len(), 3);
        assert!(extract_list(&json!("x")).is_empty());
    }
}
