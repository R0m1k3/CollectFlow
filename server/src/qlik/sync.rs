//! Route `/api/qlik/sync` (port de `src/app/api/qlik/sync/route.ts`).
//!
//! Extraction Qlik potentiellement très longue (plusieurs minutes) : la requête
//! HTTP rend la main tout de suite avec l'état du job, et le client interroge
//! `GET` toutes les 2 s. Une requête maintenue pendant toute l'extraction se
//! faisait couper par le reverse proxy.
//!
//! - Mode fournisseur (`?fournisseur=XXX`) : administrateurs uniquement.
//! - Mode produit (`?codeCentrale=YYY`, fiche produit) : tout utilisateur connecté.

use super::date_range::{build_grid_network_qlik_date_filter_now, QLIK_MONTHS_BACK_DEFAULT};
use super::network_cache::upsert_network_metrics;
use super::playwright::fetch_network_metrics_playwright;
use crate::auth::{require_admin, require_session, Token};
use crate::error::{AppError, AppResult};
use crate::logcapture::{start_capture, stop_capture};
use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

/// État d'un job de sync Qlik.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QlikSyncStatus {
    Running,
    Success,
    Error,
}

impl QlikSyncStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Success => "success",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
struct QlikSyncJob {
    job_id: String,
    /// Code fournisseur (mode fournisseur) — chaîne vide en mode produit.
    fournisseur: String,
    /// Code centrale (mode produit) — absent en mode fournisseur.
    code_centrale: Option<String>,
    status: QlikSyncStatus,
    requested: usize,
    fetched: usize,
    upserted: usize,
    periode: Option<String>,
    date_debut: Option<String>,
    date_fin: Option<String>,
    started_at: String,
    finished_at: Option<String>,
    error: Option<String>,
    message: Option<String>,
}

type JobPartage = Arc<Mutex<QlikSyncJob>>;

/// Registre en mémoire, une entrée par cible (on ne lance qu'une extraction à
/// la fois par fournisseur / par produit). Volontairement simple : si le
/// processus redémarre, les jobs en cours sont perdus → GET renverra idle et
/// l'utilisateur pourra relancer.
static JOBS: LazyLock<Mutex<HashMap<String, JobPartage>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Clé de job. Le mode fournisseur garde sa clé historique (le code fournisseur
/// brut) ; le mode produit est préfixé pour ne jamais entrer en collision.
fn job_key_for_product(code_centrale: &str) -> String {
    format!("cc:{}", code_centrale.to_uppercase())
}

/// Nombre maximum d'extractions produit simultanées.
///
/// Le mode produit est ouvert à tous les utilisateurs connectés (contrairement au
/// mode fournisseur, réservé aux admins). Une extraction sur 1 seul code est très
/// légère, mais le serveur Qlik est sujet aux saturations mémoire : on plafonne
/// la concurrence plutôt que de lui laisser prendre N requêtes en parallèle.
const MAX_CONCURRENT_PRODUCT_JOBS: usize = 3;

fn running_product_jobs() -> usize {
    JOBS.lock().iter().filter(|(k, j)| k.starts_with("cc:") && j.lock().status == QlikSyncStatus::Running).count()
}

fn base36(mut n: u128) -> String {
    const CHIFFRES: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(CHIFFRES[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Construit un jobId court et lisible (`qlik_<horodatage base 36>_<aléa>`).
fn new_job_id() -> String {
    let ms = chrono::Utc::now().timestamp_millis().max(0) as u128;
    let alea: String = (0..6).map(|_| base36(rand::random::<u8>() as u128 % 36)).collect();
    format!("qlik_{}_{alea}", base36(ms))
}

fn maintenant_iso() -> String {
    crate::db::iso_utc(chrono::Utc::now())
}

/// Sérialise un job pour la réponse HTTP (champs absents omis, comme `undefined`).
fn public_job(job: &QlikSyncJob) -> Value {
    let mut m = Map::new();
    m.insert("success".into(), Value::Bool(true));
    m.insert("jobId".into(), Value::from(job.job_id.clone()));
    m.insert("fournisseur".into(), Value::from(job.fournisseur.clone()));
    if let Some(c) = &job.code_centrale {
        m.insert("codeCentrale".into(), Value::from(c.clone()));
    }
    m.insert("status".into(), Value::from(job.status.as_str()));
    m.insert("requested".into(), Value::from(job.requested));
    m.insert("fetched".into(), Value::from(job.fetched));
    m.insert("upserted".into(), Value::from(job.upserted));
    for (k, v) in [("periode", &job.periode), ("dateDebut", &job.date_debut), ("dateFin", &job.date_fin)] {
        if let Some(v) = v {
            m.insert(k.into(), Value::from(v.clone()));
        }
    }
    m.insert("startedAt".into(), Value::from(job.started_at.clone()));
    for (k, v) in [("finishedAt", &job.finished_at), ("error", &job.error), ("message", &job.message)] {
        if let Some(v) = v {
            m.insert(k.into(), Value::from(v.clone()));
        }
    }
    Value::Object(m)
}

/// État "idle" sérialisé (pas de job connu pour cette cible).
fn idle_job(fournisseur: &str, code_centrale: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("success".into(), Value::Bool(true));
    m.insert("jobId".into(), Value::Null);
    m.insert("fournisseur".into(), Value::from(fournisseur));
    if let Some(c) = code_centrale {
        m.insert("codeCentrale".into(), Value::from(c));
    }
    m.insert("status".into(), Value::from("idle"));
    m.insert("requested".into(), Value::from(0));
    m.insert("fetched".into(), Value::from(0));
    m.insert("upserted".into(), Value::from(0));
    Value::Object(m)
}

/// Codes centraux retenus et compteurs de rejet.
#[derive(Debug, Default, PartialEq)]
pub struct CodesFiltres {
    pub accepted: Vec<String>,
    pub rejected: usize,
    pub deduped: usize,
}

/// Filtre strict des codes centraux avant d'envoyer à Qlik.
///
/// Format attendu d'après l'API FF : préfixe `10000` + 6 chiffres (ex `10000167303`).
/// Pour rester large et ne pas casser d'éventuels codes alphanumériques
/// fournisseur, on autorise longueur 2..30, jeu `[A-Z0-9_-]`, premier caractère
/// alphanumérique. But : ne jamais envoyer à Qlik des chaînes vides, des `-`,
/// des espaces parasites ou des entrées manifestement invalides, qui
/// déclenchent des erreurs Engine. On ne touche pas au mapping.
///
/// - trim + rejet des vides, de `-` et `_`
/// - doublons supprimés (ordre préservé, comparaison insensible à la casse)
/// - rejet des codes hors format
///
/// Les journaux n'exposent que les compteurs, jamais les valeurs.
pub fn filter_central_codes<I, S>(raw_codes: I) -> CodesFiltres
where
    I: IntoIterator<Item = Option<S>>,
    S: AsRef<str>,
{
    let re = regex::Regex::new(r"(?i)^[A-Z0-9][A-Z0-9_-]{1,29}$").expect("regex");
    let mut vus = std::collections::HashSet::new();
    let mut out = CodesFiltres::default();
    for raw in raw_codes {
        let Some(raw) = raw else {
            out.rejected += 1;
            continue;
        };
        let code = raw.as_ref().trim().to_string();
        let key = code.to_uppercase();
        if code.is_empty() || code == "-" || code == "_" {
            out.rejected += 1;
            continue;
        }
        if vus.contains(&key) {
            out.deduped += 1;
            continue;
        }
        if !re.is_match(&code) {
            out.rejected += 1;
            continue;
        }
        vus.insert(key);
        out.accepted.push(code);
    }
    out
}

/// Inscrit une erreur dans le job, en traduisant la saturation mémoire du
/// serveur Qlik en message actionnable (ce n'est PAS un bug CollectFlow :
/// l'app Qlik ne se charge même pas).
fn apply_job_error(job: &JobPartage, msg: &str) {
    let mut j = job.lock();
    tracing::error!("[api/qlik/sync] job={} {msg}", j.job_id);
    j.status = QlikSyncStatus::Error;
    let lower = msg.to_lowercase();
    j.error = Some(
        if lower.contains("out of memory")
            || lower.contains("not enough memory")
            || lower.contains("file corrupted")
            || lower.contains("\"code\":6")
            || lower.contains("\"code\":3002")
        {
            "Serveur Qlik saturé : mémoire insuffisante pour charger l'application. Réessayez plus tard (ou faites libérer / augmenter la RAM du serveur Qlik).".to_string()
        } else {
            msg.to_string()
        },
    );
    j.finished_at = Some(maintenant_iso());
}

fn pied_capture(job: &JobPartage) -> String {
    let j = job.lock();
    format!("statut final={}{}", j.status.as_str(), j.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default())
}

/// Extraction + upsert pour un fournisseur, en mettant à jour le job au fur et
/// à mesure (compteur fetched, puis upserted, puis finishedAt).
async fn run_job(job: JobPartage) {
    let (job_id, fournisseur, started_at) = {
        let j = job.lock();
        (j.job_id.clone(), j.fournisseur.clone(), j.started_at.clone())
    };
    // Journal téléchargeable depuis Paramètres. Ouvert AVANT le premier log du
    // job pour ne pas perdre l'entête (choix des champs, carte du modèle Qlik) —
    // c'est précisément la partie qu'un terminal tronque.
    start_capture(&job_id, Some(&format!("sync fournisseur={fournisseur} démarrée le {started_at}")));
    let res: anyhow::Result<()> = async {
        let articles = crate::ff::pg::pg_get_articles_by_fournisseur(&fournisseur).await?;
        // Filtre strict des codes (trim, dedupe, exclusion vides/`-`/codes trop suspects).
        let filtres = filter_central_codes(articles.iter().map(|a| a.code_centrale.as_deref()));
        let codes = filtres.accepted;
        job.lock().requested = codes.len();
        tracing::info!(
            "[api/qlik/sync] job={job_id} fournisseur={fournisseur} — {} articles, {} codes centraux retenus, {} rejetés (vide/-/anormaux), {} doublons supprimés",
            articles.len(),
            codes.len(),
            filtres.rejected,
            filtres.deduped
        );
        if codes.is_empty() {
            let mut j = job.lock();
            j.status = QlikSyncStatus::Success;
            j.message = Some("Aucun code centrale valide pour ce fournisseur".into());
            j.finished_at = Some(maintenant_iso());
            return Ok(());
        }

        // Contrat métier strict : toujours 12 mois complets glissants.
        // Une variable d'environnement ne doit pas pouvoir raccourcir la série.
        let date_filter = build_grid_network_qlik_date_filter_now(QLIK_MONTHS_BACK_DEFAULT);
        {
            let mut j = job.lock();
            j.periode = Some(date_filter.label.clone());
            j.date_debut = Some(date_filter.date_debut.clone());
            j.date_fin = Some(date_filter.date_fin.clone());
        }
        tracing::info!(
            "[api/qlik/sync] job={job_id} → extraction Qlik pour {} codes — 12 mois complets {} ({} → {})…",
            codes.len(),
            date_filter.label,
            date_filter.date_debut,
            date_filter.date_fin
        );
        // Le code fournisseur est transmis en plus des codes : s'il désigne dans
        // Qlik le même périmètre (couverture vérifiée côté extracteur), une seule
        // sélection remplace les dizaines de milliers de `SelectValues` par code.
        // Les codes restent le repli et le contrôle de couverture.
        let metrics = fetch_network_metrics_playwright(Some(codes), None, Some(date_filter), Some(fournisseur.clone())).await?;
        job.lock().fetched = metrics.len();
        tracing::info!("[api/qlik/sync] job={job_id} ← Qlik a renvoyé {} produits réseau", metrics.len());
        let valeurs: Vec<_> = metrics.into_values().collect();
        let count = upsert_network_metrics(&valeurs).await?;
        tracing::info!("[api/qlik/sync] job={job_id} {count} lignes upsert dans le cache");
        let mut j = job.lock();
        j.upserted = count;
        j.status = QlikSyncStatus::Success;
        j.finished_at = Some(maintenant_iso());
        Ok(())
    }
    .await;
    if let Err(e) = res {
        apply_job_error(&job, &format!("{e:#}"));
    }
    stop_capture(&job_id, Some(&pied_capture(&job)));
}

/// Extraction Qlik pour UN seul code centrale (fiche produit).
///
/// Beaucoup plus légère que la sync fournisseur : un seul code au lieu de
/// plusieurs centaines, sur la même fenêtre 12 mois glissants. Réutilise
/// exactement le même extracteur, donc le même détail mensuel.
async fn run_product_job(job: JobPartage) {
    let (job_id, code, started_at) = {
        let j = job.lock();
        (j.job_id.clone(), j.code_centrale.clone().unwrap_or_default(), j.started_at.clone())
    };
    start_capture(&job_id, Some(&format!("sync produit={code} démarrée le {started_at}")));
    let res: anyhow::Result<()> = async {
        let date_filter = build_grid_network_qlik_date_filter_now(QLIK_MONTHS_BACK_DEFAULT);
        {
            let mut j = job.lock();
            j.requested = 1;
            j.periode = Some(date_filter.label.clone());
            j.date_debut = Some(date_filter.date_debut.clone());
            j.date_fin = Some(date_filter.date_fin.clone());
        }
        tracing::info!(
            "[api/qlik/sync] job={job_id} → extraction Qlik produit (1 code) — fenêtre {} ({} → {})…",
            date_filter.label,
            date_filter.date_debut,
            date_filter.date_fin
        );
        let metrics = fetch_network_metrics_playwright(Some(vec![code.clone()]), None, Some(date_filter), None).await?;
        job.lock().fetched = metrics.len();
        if metrics.is_empty() {
            let mut j = job.lock();
            j.status = QlikSyncStatus::Success;
            j.message = Some("Ce code centrale est inconnu de Qlik (aucune vente réseau sur la période)".into());
            j.finished_at = Some(maintenant_iso());
            return Ok(());
        }
        let valeurs: Vec<_> = metrics.into_values().collect();
        let count = upsert_network_metrics(&valeurs).await?;
        {
            let mut j = job.lock();
            j.upserted = count;
            j.status = QlikSyncStatus::Success;
            j.message = Some("Données réseau récupérées".into());
            j.finished_at = Some(maintenant_iso());
        }
        tracing::info!("[api/qlik/sync] job={job_id} produit {code} — {count} ligne(s) upsert");
        Ok(())
    }
    .await;
    if let Err(e) = res {
        apply_job_error(&job, &format!("{e:#}"));
    }
    stop_capture(&job_id, Some(&pied_capture(&job)));
}

/// Lancement « fire-and-forget » : on ne bloque pas la réponse HTTP. Filet de
/// sécurité : une panique du job ne doit jamais laisser le job « running ».
fn lancer(job: JobPartage, produit: bool) {
    let suivi = job.clone();
    let tache = if produit { tokio::spawn(run_product_job(job)) } else { tokio::spawn(run_job(job)) };
    tokio::spawn(async move {
        if let Err(e) = tache.await {
            let msg = format!("crash non géré : {e}");
            tracing::error!("[api/qlik/sync] job={} {msg}", suivi.lock().job_id);
            let mut j = suivi.lock();
            j.status = QlikSyncStatus::Error;
            j.error = Some(msg);
            j.finished_at = Some(maintenant_iso());
        }
    });
}

fn param<'a>(q: &'a HashMap<String, String>, nom: &str) -> Option<&'a str> {
    q.get(nom).map(|s| s.as_str()).filter(|s| !s.is_empty())
}

const PARAM_REQUIS: &str = "Param 'fournisseur' ou 'codeCentrale' requis";

/// GET /api/qlik/sync?fournisseur=XXX ou ?codeCentrale=YYY
///
/// Retourne l'état courant du job pour cette cible ; « idle » si aucun job
/// n'est connu. Permet au client de reprendre l'état après un rechargement et
/// de suivre l'avancement en arrière-plan.
pub async fn get(Token(token): Token, Query(q): Query<HashMap<String, String>>) -> AppResult<Json<Value>> {
    // Mode produit : ouvert à tout utilisateur connecté.
    if let Some(code_centrale) = param(&q, "codeCentrale") {
        require_session(token.as_ref()).await?;
        let job = JOBS.lock().get(&job_key_for_product(code_centrale)).cloned();
        return Ok(Json(match job {
            Some(j) => public_job(&j.lock()),
            None => idle_job("", Some(code_centrale)),
        }));
    }

    // Mode fournisseur : admin uniquement.
    require_admin(token.as_ref()).await?;
    let Some(fournisseur) = param(&q, "fournisseur") else {
        return Err(AppError::bad_request(PARAM_REQUIS));
    };
    let job = JOBS.lock().get(fournisseur).cloned();
    Ok(Json(match job {
        Some(j) => public_job(&j.lock()),
        None => idle_job(fournisseur, None),
    }))
}

/// POST /api/qlik/sync?fournisseur=XXX ou ?codeCentrale=YYY
///
/// Démarre (ou réutilise s'il tourne déjà) un job d'extraction en arrière-plan
/// et retourne *immédiatement* son état. Le client suit ensuite via GET.
pub async fn post(Token(token): Token, Query(q): Query<HashMap<String, String>>) -> AppResult<Json<Value>> {
    // ─── Mode produit : 1 code centrale, ouvert à tout utilisateur connecté ───
    if let Some(code_param) = param(&q, "codeCentrale") {
        require_session(token.as_ref()).await?;
        // Même validation que la sync fournisseur (trim, rejet des vides / "-" /
        // codes hors charset) pour ne jamais envoyer de saleté à l'Engine Qlik.
        let filtres = filter_central_codes([Some(code_param)]);
        let Some(code) = filtres.accepted.into_iter().next() else {
            return Err(AppError::bad_request("Code centrale invalide"));
        };
        let key = job_key_for_product(&code);
        if let Some(existant) = JOBS.lock().get(&key).cloned() {
            let j = existant.lock();
            if j.status == QlikSyncStatus::Running {
                return Ok(Json(public_job(&j)));
            }
        }
        if running_product_jobs() >= MAX_CONCURRENT_PRODUCT_JOBS {
            return Err(AppError::new(StatusCode::TOO_MANY_REQUESTS, "Trop d'extractions Qlik en cours. Réessayez dans quelques instants."));
        }
        let job = Arc::new(Mutex::new(QlikSyncJob {
            job_id: new_job_id(),
            fournisseur: String::new(),
            code_centrale: Some(code.clone()),
            status: QlikSyncStatus::Running,
            requested: 0,
            fetched: 0,
            upserted: 0,
            periode: None,
            date_debut: None,
            date_fin: None,
            started_at: maintenant_iso(),
            finished_at: None,
            error: None,
            message: None,
        }));
        JOBS.lock().insert(key, job.clone());
        let corps = public_job(&job.lock());
        tracing::info!("[api/qlik/sync] job={} démarré pour codeCentrale={code}", job.lock().job_id);
        lancer(job, true);
        return Ok(Json(corps));
    }

    // ─── Mode fournisseur : admin uniquement ──────────────────────────────────
    require_admin(token.as_ref()).await?;
    let Some(fournisseur) = param(&q, "fournisseur") else {
        return Err(AppError::bad_request(PARAM_REQUIS));
    };
    if let Some(existant) = JOBS.lock().get(fournisseur).cloned() {
        let j = existant.lock();
        if j.status == QlikSyncStatus::Running {
            // Un job tourne déjà pour ce fournisseur : on le réutilise.
            return Ok(Json(public_job(&j)));
        }
    }
    let job = Arc::new(Mutex::new(QlikSyncJob {
        job_id: new_job_id(),
        fournisseur: fournisseur.to_string(),
        code_centrale: None,
        status: QlikSyncStatus::Running,
        requested: 0,
        fetched: 0,
        upserted: 0,
        periode: None,
        date_debut: None,
        date_fin: None,
        started_at: maintenant_iso(),
        finished_at: None,
        error: None,
        message: None,
    }));
    JOBS.lock().insert(fournisseur.to_string(), job.clone());
    let corps = public_job(&job.lock());
    tracing::info!("[api/qlik/sync] job={} démarré pour fournisseur={fournisseur}", job.lock().job_id);
    // Lancement fire-and-forget : on renvoie tout de suite au client, qui suit
    // via GET. Les erreurs sont capturées dans le job.
    lancer(job, false);
    Ok(Json(corps))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filtre_des_codes_centraux() {
        let long = "X".repeat(31);
        let r = filter_central_codes([
            Some(" 10000167303 "),
            None,
            Some(""),
            Some("-"),
            Some("_"),
            Some("10000167303"),
            Some("abc"),
            Some("ABC"),
            Some("a"),
            Some("_x1"),
            Some("code avec espace"),
            Some(long.as_str()),
        ]);
        assert_eq!(r.accepted, vec!["10000167303".to_string(), "abc".to_string()]);
        assert_eq!(r.deduped, 2);
        assert_eq!(r.rejected, 8);
    }

    #[test]
    fn formes_json() {
        let idle = idle_job("", Some("100"));
        assert_eq!(
            idle.to_string(),
            r#"{"success":true,"jobId":null,"fournisseur":"","codeCentrale":"100","status":"idle","requested":0,"fetched":0,"upserted":0}"#
        );
        let job = QlikSyncJob {
            job_id: "qlik_x_y".into(),
            fournisseur: "J009".into(),
            code_centrale: None,
            status: QlikSyncStatus::Error,
            requested: 3,
            fetched: 0,
            upserted: 0,
            periode: Some("2025-10_2026-09".into()),
            date_debut: Some("2025-10-01".into()),
            date_fin: Some("2026-09-30".into()),
            started_at: "2026-10-12T08:00:00.000Z".into(),
            finished_at: Some("2026-10-12T08:01:00.000Z".into()),
            error: Some("boom".into()),
            message: None,
        };
        assert_eq!(
            public_job(&job).to_string(),
            r#"{"success":true,"jobId":"qlik_x_y","fournisseur":"J009","status":"error","requested":3,"fetched":0,"upserted":0,"periode":"2025-10_2026-09","dateDebut":"2025-10-01","dateFin":"2026-09-30","startedAt":"2026-10-12T08:00:00.000Z","finishedAt":"2026-10-12T08:01:00.000Z","error":"boom"}"#
        );
        assert!(new_job_id().starts_with("qlik_"));
        assert_eq!(base36(35), "z");
    }

    #[test]
    fn saturation_memoire_traduite() {
        let job = Arc::new(Mutex::new(QlikSyncJob {
            job_id: "j".into(),
            fournisseur: "F".into(),
            code_centrale: None,
            status: QlikSyncStatus::Running,
            requested: 0,
            fetched: 0,
            upserted: 0,
            periode: None,
            date_debut: None,
            date_fin: None,
            started_at: String::new(),
            finished_at: None,
            error: None,
            message: None,
        }));
        apply_job_error(&job, r#"[qlik-pw] {"code":6,"message":"Not enough memory"}"#);
        assert!(job.lock().error.as_deref().unwrap().starts_with("Serveur Qlik saturé"));
        assert_eq!(job.lock().status, QlikSyncStatus::Error);
    }
}
