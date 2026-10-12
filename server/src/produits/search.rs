//! CollectFlow — Recherche produit **Qlik d'abord**, base FF Nancy ensuite —
//! port de `src/features/produits/api/search-produits.ts`.
//!
//! Déroulé :
//!   1. Qlik Sense, **une seule session** : les articles correspondant au terme ET
//!      leurs mesures réseau sur 12 mois glissants (`search_qlik_articles`).
//!   2. Base FF Nancy : lesquels référençons-nous ? (`pg_get_produits_by_code_centrale`)
//!   3. Cache `qlik_network_metrics` : détail mensuel quand une sync l'a déjà
//!      extrait (le cube de recherche est agrégé, il ne le fournit pas).
//!
//! Une seconde session Qlik pour les mesures faisait abandonner le moteur
//! (`code 15 — Request aborted`) : deux sessions concurrentes sur la même app,
//! dont une avec une grosse sélection, et l'Engine coupe les requêtes.
//!
//! Si Qlik est injoignable, on se rabat sur la recherche catalogue local pour ne
//! pas laisser l'utilisateur sans résultat — la réponse le signale explicitement
//! (`source: "db"`).

use super::compare_reseau::normalize_marge_pct;
use super::types::{ProduitRechercheResultat, ProduitRechercheRow, SourceRecherche};
use crate::ff::pg::{compare_fr, pg_get_produits_by_code_centrale, pg_search_produits, PgProduitSearchRow};
use crate::grid::js::{js_trim, replace_whitespace_runs};
use crate::grid::months::today;
use crate::grid::network_trend::{build_rolling12_qlik_months, NB_MAGASINS_RESEAU};
use crate::qlik::network_cache::upsert_network_metrics;
use crate::qlik::search::{search_qlik_articles, QLIK_SEARCH_MAX_RESULTS};
use crate::qlik::{get_network_metrics_by_code_centrale, NetworkMetric, NetworkMetricCached, QlikMonthMetrics};
use chrono::NaiveDate;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

/// Durée de validité d'un résultat de recherche en cache mémoire.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// Durée de conservation d'un job terminé (le client a le temps de le relire).
const JOB_TTL: Duration = Duration::from_secs(5 * 60);

/// Nombre de lignes de la recherche catalogue local (50 dans le code d'origine).
const LIMITE_RECHERCHE_LOCALE: i64 = 50;

/// Série « magasins vendeurs » extraite du détail mensuel du cache.
///
/// Un mois PRÉSENT dans le détail est un mois extrait : sans `nbMag`, c'est
/// qu'aucun magasin n'a vendu, donc zéro. Le traiter comme manquant amputerait la
/// série et priverait la tendance de son dénominateur.
fn nb_mag_par_mois(metrics_by_month: Option<&BTreeMap<String, QlikMonthMetrics>>) -> Option<BTreeMap<String, f64>> {
    let metrics_by_month = metrics_by_month?;
    let par_mois: BTreeMap<String, f64> = metrics_by_month
        .iter()
        .map(|(mois, m)| (mois.clone(), m.nb_mag.filter(|nb| nb.is_finite()).unwrap_or(0.0)))
        .collect();
    if par_mois.is_empty() {
        None
    } else {
        Some(par_mois)
    }
}

/// Un cache réseau n'est fiable que s'il porte explicitement les 12 mois attendus.
fn cache_reseau_complet(cache: Option<&NetworkMetricCached>, periode: Option<&str>, now: NaiveDate) -> bool {
    let Some(cache) = cache else { return false };
    let (Some(par_mois), Some(periode)) = (cache.qte_by_month.as_ref(), periode) else {
        return false;
    };
    if cache.periode.as_deref() != Some(periode) {
        return false;
    }
    build_rolling12_qlik_months(now).iter().all(|mois| par_mois.get(mois).is_some_and(|v| v.is_finite()))
}

/// Nombre maximum de recherches Qlik simultanées.
///
/// Le serveur Qlik sature vite (« Out of memory », « Request aborted ») : on
/// plafonne plutôt que de lui envoyer N extractions en parallèle.
const MAX_RECHERCHES_SIMULTANEES: usize = 1;

/// Cache mémoire des recherches. Une recherche coûte deux allers-retours Qlik
/// (plusieurs secondes chacun) : sans ce cache, un retour arrière du navigateur
/// ou un rafraîchissement relancerait toute l'extraction.
static CACHE: LazyLock<Mutex<HashMap<String, EntreeCache>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Résultat en cache et instant de sa mise en cache.
type EntreeCache = (Instant, Arc<ProduitRechercheResultat>);

/// Jobs de recherche, indexés par terme normalisé.
///
/// Une recherche dure de quelques secondes à plusieurs minutes (deux allers-retours
/// Qlik dont une extraction mensuelle). Une requête HTTP maintenue aussi longtemps
/// se fait couper par le reverse proxy, qui répond une page d'erreur HTML — le
/// client recevait alors « Unexpected token '<' … is not valid JSON ». Le travail
/// tourne donc en tâche de fond et le client interroge l'état.
static JOBS: LazyLock<Mutex<HashMap<String, JobPartage>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

type JobPartage = Arc<Mutex<RechercheJob>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatutRecherche {
    Running,
    Success,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RechercheJob {
    pub job_id: String,
    pub terme: String,
    pub status: StatutRecherche,
    /// Étape en cours, affichée pendant l'attente.
    pub etape: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Arc<ProduitRechercheResultat>>,
    /// Instant de fin (purge), non sérialisé.
    #[serde(skip)]
    termine: Option<Instant>,
}

/// État renvoyé au client : le job, ou `idle` si aucune recherche connue.
#[derive(Debug, Clone)]
pub enum RechercheEtat {
    Job(RechercheJob),
    Idle { terme: String },
}

impl RechercheEtat {
    /// Corps de réponse `{ success: true, ...etat }`.
    pub fn reponse(&self) -> Value {
        let mut m = Map::new();
        m.insert("success".into(), Value::Bool(true));
        match self {
            RechercheEtat::Job(job) => {
                if let Ok(Value::Object(champs)) = serde_json::to_value(job) {
                    m.extend(champs);
                }
            }
            RechercheEtat::Idle { terme } => {
                m.insert("status".into(), Value::from("idle"));
                m.insert("terme".into(), Value::from(terme.clone()));
            }
        }
        Value::Object(m)
    }
}

fn cache_key(term: &str) -> String {
    replace_whitespace_runs(&js_trim(term).to_lowercase(), " ")
}

fn maintenant_iso() -> String {
    crate::db::iso_utc(chrono::Utc::now())
}

/// `n.toString(36)`.
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

fn horodatage_base36() -> String {
    base36(chrono::Utc::now().timestamp_millis().max(0) as u128)
}

/// `Math.random().toString(36).slice(2, 8)` : 6 caractères base 36.
fn alea_base36() -> String {
    (0..6).map(|_| base36(rand::random::<u8>() as u128 % 36)).collect()
}

/// `s.slice(0, n)` en JS (unités UTF-16).
fn slice_js(s: &str, n: usize) -> String {
    let mut unites = 0;
    let mut out = String::new();
    for c in s.chars() {
        unites += c.len_utf16();
        if unites > n {
            break;
        }
        out.push(c);
    }
    out
}

/// Purge les entrées expirées (le volume reste faible, un balayage suffit).
fn purge(jobs: &mut HashMap<String, JobPartage>) {
    CACHE.lock().retain(|_, (at, _)| at.elapsed() <= CACHE_TTL);
    jobs.retain(|_, j| {
        let j = j.lock();
        !(j.status != StatutRecherche::Running && j.termine.is_some_and(|t| t.elapsed() > JOB_TTL))
    });
}

fn jobs_en_cours(jobs: &HashMap<String, JobPartage>) -> usize {
    jobs.values().filter(|j| j.lock().status == StatutRecherche::Running).count()
}

fn job_termine(terme: &str, result: Arc<ProduitRechercheResultat>) -> RechercheJob {
    let maintenant = maintenant_iso();
    RechercheJob {
        job_id: format!("cache_{}", cache_key(terme)),
        terme: terme.to_string(),
        status: StatutRecherche::Success,
        etape: "Terminé".into(),
        started_at: maintenant.clone(),
        finished_at: Some(maintenant),
        error: None,
        result: Some(result),
        termine: Some(Instant::now()),
    }
}

/// Démarre (ou réutilise) une recherche et rend la main **immédiatement**.
///
/// - résultat déjà en cache et pas de `force` → job `success` directement ;
/// - recherche déjà en cours sur le même terme → on renvoie ce job ;
/// - sinon on lance le travail en tâche de fond.
pub fn demarrer_recherche(term: &str, force: bool) -> RechercheJob {
    let cleaned = js_trim(term).to_string();
    let key = cache_key(&cleaned);
    // Verrou tenu de bout en bout : la vérification « déjà en cours ? » et
    // l'enregistrement du nouveau job doivent être atomiques (le TS, mono-thread,
    // l'était par construction).
    let mut jobs = JOBS.lock();
    purge(&mut jobs);

    if !force {
        let hit = CACHE.lock().get(&key).map(|(_, r)| r.clone());
        if let Some(result) = hit {
            tracing::info!("[produits/search] \"{cleaned}\" — servi depuis le cache mémoire");
            return job_termine(&cleaned, result);
        }
    }

    if let Some(existant) = jobs.get(&key) {
        let j = existant.lock();
        if j.status == StatutRecherche::Running {
            return j.clone();
        }
        if !force && j.status == StatutRecherche::Success && j.result.is_some() {
            return j.clone();
        }
    }

    if jobs_en_cours(&jobs) >= MAX_RECHERCHES_SIMULTANEES {
        let maintenant = maintenant_iso();
        return RechercheJob {
            job_id: format!("refus_{}", horodatage_base36()),
            terme: cleaned,
            status: StatutRecherche::Error,
            etape: "Refusé".into(),
            started_at: maintenant.clone(),
            finished_at: Some(maintenant),
            error: Some("Trop de recherches Qlik en cours. Réessayez dans quelques instants.".into()),
            result: None,
            termine: Some(Instant::now()),
        };
    }

    let job = RechercheJob {
        job_id: format!("rech_{}_{}", horodatage_base36(), alea_base36()),
        terme: cleaned.clone(),
        status: StatutRecherche::Running,
        etape: "Recherche des articles dans Qlik…".into(),
        started_at: maintenant_iso(),
        finished_at: None,
        error: None,
        result: None,
        termine: None,
    };
    let partage: JobPartage = Arc::new(Mutex::new(job.clone()));
    jobs.insert(key.clone(), partage.clone());
    drop(jobs);
    tracing::info!("[produits/search] job={} démarré pour \"{cleaned}\"", job.job_id);

    lancer(partage, cleaned, key);
    job
}

/// Fire-and-forget : le client suivra l'avancement via [`etat_recherche`].
/// Filet de sécurité : une panique de la recherche ne doit jamais laisser le
/// job « running » (il bloquerait toutes les recherches suivantes).
fn lancer(job: JobPartage, terme: String, key: String) {
    let suivi = job.clone();
    let tache = tokio::spawn(async move {
        let etape = suivi.clone();
        executer_recherche(&terme, move |e| etape.lock().etape = e.to_string()).await
    });
    tokio::spawn(async move {
        match tache.await {
            Ok(result) => {
                let result = Arc::new(result);
                let (job_id, n, duree) = {
                    let mut j = job.lock();
                    j.result = Some(result.clone());
                    j.status = StatutRecherche::Success;
                    j.etape = "Terminé".into();
                    j.finished_at = Some(maintenant_iso());
                    j.termine = Some(Instant::now());
                    (j.job_id.clone(), result.rows.len(), result.duree_ms)
                };
                // On ne met en cache qu'un résultat Qlik exploitable : mémoriser un
                // repli catalogue (panne Qlik passagère) le figerait 10 minutes
                // alors qu'un simple « Relancer » aurait suffi.
                if result.source == SourceRecherche::Qlik && result.qlik_error.is_none() {
                    CACHE.lock().insert(key, (Instant::now(), result));
                }
                tracing::info!("[produits/search] job={job_id} terminé — {n} produit(s) en {duree} ms");
            }
            Err(e) => {
                let message = e.to_string();
                let job_id = {
                    let mut j = job.lock();
                    j.status = StatutRecherche::Error;
                    j.etape = "Échec".into();
                    j.error = Some(message_qlik_lisible(&message));
                    j.finished_at = Some(maintenant_iso());
                    j.termine = Some(Instant::now());
                    j.job_id.clone()
                };
                tracing::error!("[produits/search] job={job_id} échec : {}", slice_js(&message, 300));
            }
        }
    });
}

/// État courant de la recherche pour ce terme (pour le polling client).
pub fn etat_recherche(term: &str) -> RechercheEtat {
    let cleaned = js_trim(term).to_string();
    let key = cache_key(&cleaned);
    let mut jobs = JOBS.lock();
    purge(&mut jobs);
    if let Some(job) = jobs.get(&key) {
        return RechercheEtat::Job(job.lock().clone());
    }
    drop(jobs);
    let hit = CACHE.lock().get(&key).map(|(_, r)| r.clone());
    if let Some(result) = hit {
        return RechercheEtat::Job(job_termine(&cleaned, result));
    }
    RechercheEtat::Idle { terme: cleaned }
}

/// `a || b` sur des chaînes (une chaîne vide est « fausse »).
fn ou<'a>(a: &'a str, b: &'a str) -> &'a str {
    if a.is_empty() {
        b
    } else {
        a
    }
}

async fn executer_recherche(term: &str, on_etape: impl Fn(&str)) -> ProduitRechercheResultat {
    let started = Instant::now();
    let duree_ms = || started.elapsed().as_millis() as u64;

    // La recherche catalogue local tourne en parallèle : elle sert à la fois de
    // repli si Qlik échoue, et de complément (produits Nancy sans code centrale,
    // donc invisibles côté réseau).
    let terme_local = term.to_string();
    let local = tokio::spawn(async move { pg_search_produits(&terme_local, LIMITE_RECHERCHE_LOCALE).await });
    let locaux = move || async move {
        local.await.unwrap_or_else(|e| {
            tracing::error!("[produits/search] recherche locale échouée: {e}");
            Vec::<PgProduitSearchRow>::new()
        })
    };

    on_etape("Recherche des articles dans Qlik…");
    let qlik = match search_qlik_articles(term, Some(QLIK_SEARCH_MAX_RESULTS), None).await {
        Ok(q) => q,
        Err(e) => {
            let message = format!("{e:#}");
            tracing::error!("[produits/search] Qlik indisponible, repli catalogue local: {message}");
            let locaux = locaux().await;
            return ProduitRechercheResultat {
                rows: locaux.iter().map(row_depuis_catalogue_seul).collect(),
                source: SourceRecherche::Db,
                qlik_error: Some(message_qlik_lisible(&message)),
                tronque: locaux.len() as i64 >= LIMITE_RECHERCHE_LOCALE,
                champ_utilise: None,
                locaux_hors_reseau: vec![],
                duree_ms: duree_ms(),
            };
        }
    };

    let codes: Vec<String> = qlik.matches.iter().map(|m| m.code_centrale.clone()).collect();
    if codes.is_empty() {
        let locaux = locaux().await;
        return ProduitRechercheResultat {
            rows: vec![],
            source: SourceRecherche::Qlik,
            // `avertissement` n'est renseigné que si Qlik a répondu sans appliquer
            // le filtre : l'utilisateur doit savoir que ce n'est pas « pas de
            // produit » mais « recherche non appliquée ».
            qlik_error: qlik.avertissement,
            tronque: false,
            champ_utilise: qlik.champ_utilise,
            locaux_hors_reseau: locaux,
            duree_ms: duree_ms(),
        };
    }

    // Les mesures réseau sortent DÉJÀ du cube de recherche (même session Qlik).
    // Les extraire dans une seconde session concurrente faisait abandonner le
    // moteur (`code 15 — Request aborted`) : c'est ce qui faisait « planter » la
    // recherche alors que la sync de la Grille, elle seule sur le serveur,
    // fonctionnait.
    //
    // Reste à récupérer le détail mensuel — indisponible dans ce cube. On le lit
    // dans le cache alimenté par les syncs fournisseur ; s'il manque, la fiche
    // produit propose son bouton « Actualiser depuis Qlik ».
    on_etape("Rapprochement avec notre catalogue…");
    // Deux clés candidates : la dimension « Article Code » et le champ
    // `article_no_centrale`. Sur l'app FF elles n'ont pas le même format et
    // une seule joint avec `articles.artcentrale`.
    let candidats: Vec<String> = codes
        .iter()
        .cloned()
        .chain(qlik.matches.iter().map(|m| m.code_centrale_alt.clone()).filter(|c| !c.is_empty()))
        .collect();
    let (cache_reseau, catalogue, locaux) = tokio::join!(
        async {
            get_network_metrics_by_code_centrale(&codes).await.unwrap_or_else(|e| {
                tracing::error!("[produits/search] lecture du cache réseau échouée: {e:#}");
                HashMap::new()
            })
        },
        pg_get_produits_by_code_centrale(&candidats),
        locaux(),
    );

    let now = today();
    let periode = qlik.periode.as_deref();

    // Le cube de recherche utilise encore les master measures annuelles pour
    // classer rapidement les résultats. Il ne doit jamais écraser une extraction
    // 12 mois déjà vérifiée : dans ce cas on republie les valeurs du cache avec
    // leur mensuel. Sans cache complet, les valeurs de découverte restent
    // temporaires jusqu'au bouton « Actualiser depuis Qlik ».
    let a_persister: Vec<NetworkMetric> = qlik
        .matches
        .iter()
        .map(|m| {
            let cache = cache_reseau.get(&m.code_centrale);
            let fiable = cache.filter(|c| cache_reseau_complet(Some(c), periode, now));
            NetworkMetric {
                code_centrale: m.code_centrale.clone(),
                ca_reseau: fiable.map_or(m.ca_reseau, |c| c.ca_reseau),
                qte_reseau: fiable.map_or(m.qte_reseau, |c| c.qte_reseau),
                nb_magasins_reseau: fiable.map_or(m.nb_magasins_reseau, |c| c.nb_magasins_reseau),
                ca_par_magasin_reseau: fiable.map_or(m.ca_par_magasin_reseau, |c| c.ca_par_magasin_reseau),
                marge_pct_reseau: fiable.map_or(m.marge_pct_reseau, |c| c.marge_pct_reseau),
                periode: match fiable {
                    Some(c) => c.periode.clone(),
                    None => qlik.periode.clone(),
                },
                qte_by_month: fiable.and_then(|c| c.qte_by_month.clone()),
                metrics_by_month: fiable.and_then(|c| c.metrics_by_month.clone()),
                libelle_reseau: Some(m.libelle.clone()).filter(|s| !s.is_empty()),
                fournisseur_reseau: Some(m.fournisseur.clone()).filter(|s| !s.is_empty()),
            }
        })
        .collect();
    match upsert_network_metrics(&a_persister).await {
        Ok(n) => tracing::info!("[produits/search] {n} ligne(s) réseau mises en cache"),
        Err(e) => tracing::error!("[produits/search] mise en cache des mesures échouée: {e:#}"),
    }

    let mut rows: Vec<ProduitRechercheRow> = qlik
        .matches
        .iter()
        .map(|m| {
            let local = catalogue
                .get(&m.code_centrale)
                .or_else(|| if m.code_centrale_alt.is_empty() { None } else { catalogue.get(&m.code_centrale_alt) });
            let cache = cache_reseau.get(&m.code_centrale);
            let fiable = cache.filter(|c| cache_reseau_complet(Some(c), periode, now));
            let qte_reseau = fiable.map_or(m.qte_reseau, |c| c.qte_reseau);
            let ca_reseau = fiable.map_or(m.ca_reseau, |c| c.ca_reseau);
            let nb_mag = fiable.map_or(m.nb_magasins_reseau, |c| c.nb_magasins_reseau);
            let ca_par_magasin = fiable.map_or(m.ca_par_magasin_reseau, |c| c.ca_par_magasin_reseau);
            let marge_pct = fiable.map_or(m.marge_pct_reseau, |c| c.marge_pct_reseau);
            ProduitRechercheRow {
                code_centrale: m.code_centrale.clone(),
                libelle: ou(ou(local.map_or("", |l| l.libelle1.as_str()), &m.libelle), &m.code_centrale).to_string(),
                libelle_reseau: m.libelle.clone(),
                fournisseur: ou(local.map_or("", |l| l.fournisseur.as_str()), &m.fournisseur).to_string(),
                codein: local.map(|l| l.codein.clone()),
                nomenclature: local.map(|l| l.nomenclature.clone()).unwrap_or_default(),
                stock_local: local.map(|l| if l.stock_total.is_nan() { 0.0 } else { l.stock_total }),
                qte_reseau,
                ca_reseau,
                nb_magasins_reseau: nb_mag,
                taux_presence: nb_mag / NB_MAGASINS_RESEAU,
                qte_par_magasin_reseau: if nb_mag > 0.0 { qte_reseau / nb_mag } else { 0.0 },
                ca_par_magasin_reseau: ca_par_magasin,
                prix_moyen_reseau: if qte_reseau > 0.0 { Some(ca_reseau / qte_reseau) } else { None },
                marge_pct_reseau: normalize_marge_pct(Some(marge_pct)),
                // Le mensuel ne vient que du cache : le cube de recherche est agrégé.
                qte_by_month: fiable.and_then(|c| c.qte_by_month.clone()),
                nb_mag_by_month: fiable.and_then(|c| nb_mag_par_mois(c.metrics_by_month.as_ref())),
                periode: qlik.periode.clone(),
            }
        })
        .collect();

    // Les plus vendus du réseau d'abord : c'est l'information utile pour
    // arbitrer, un produit que le réseau ne vend pas n'intéresse personne.
    trier_lignes(&mut rows);

    // Les produits Nancy déjà couverts par un résultat réseau ne doivent pas
    // réapparaître dans la liste secondaire. On compare sur les deux clés
    // candidates, la jointure pouvant se faire par l'une ou par l'autre.
    let mut codes_trouves: HashSet<&str> = codes.iter().map(|c| c.as_str()).collect();
    for m in &qlik.matches {
        if !m.code_centrale_alt.is_empty() {
            codes_trouves.insert(m.code_centrale_alt.as_str());
        }
    }
    let locaux_hors_reseau: Vec<PgProduitSearchRow> =
        locaux.into_iter().filter(|l| l.code_centrale.is_empty() || !codes_trouves.contains(l.code_centrale.as_str())).collect();

    // Diagnostic de la jointure : 0 rapprochement sur 40 codes signale un format
    // de clé différent entre Qlik et `articles.artcentrale`.
    if catalogue.is_empty() && !codes.is_empty() {
        let echantillon: Vec<&String> = codes.iter().take(3).collect();
        let alt: Vec<&String> = qlik.matches.iter().take(3).map(|m| &m.code_centrale_alt).collect();
        tracing::warn!(
            "[produits/search] aucun des {} codes Qlik ne joint avec articles.artcentrale — échantillon Article Code={} article_no_centrale={}",
            codes.len(),
            serde_json::to_string(&echantillon).unwrap_or_default(),
            serde_json::to_string(&alt).unwrap_or_default(),
        );
    }

    ProduitRechercheResultat {
        rows,
        source: SourceRecherche::Qlik,
        qlik_error: qlik.avertissement,
        tronque: qlik.tronque,
        champ_utilise: qlik.champ_utilise,
        locaux_hors_reseau,
        duree_ms: duree_ms(),
    }
}

/// `rows.sort((a, b) => b.qteReseau - a.qteReseau || a.libelle.localeCompare(b.libelle, "fr"))`.
///
/// Une quantité `NaN` (mesure Qlik absente) rendait le comparateur JS
/// incohérent ; ici elle est classée en dernier pour garder un ordre total
/// (le tri Rust l'exige).
fn trier_lignes(rows: &mut [ProduitRechercheRow]) {
    let qte = |r: &ProduitRechercheRow| if r.qte_reseau.is_nan() { f64::NEG_INFINITY } else { r.qte_reseau + 0.0 };
    rows.sort_by(|a, b| qte(b).total_cmp(&qte(a)).then_with(|| compare_fr(&a.libelle, &b.libelle)));
}

/// Ligne de repli : catalogue Nancy seul, sans données réseau fiables.
fn row_depuis_catalogue_seul(r: &PgProduitSearchRow) -> ProduitRechercheRow {
    let qte_reseau = if r.qte_reseau.is_nan() { 0.0 } else { r.qte_reseau };
    let nb_mag = r.nb_magasins_reseau as f64;
    ProduitRechercheRow {
        code_centrale: r.code_centrale.clone(),
        libelle: ou(&r.libelle1, &r.codein).to_string(),
        libelle_reseau: String::new(),
        fournisseur: r.fournisseur.clone(),
        codein: Some(r.codein.clone()),
        nomenclature: r.nomenclature.clone(),
        stock_local: Some(if r.stock_total.is_nan() { 0.0 } else { r.stock_total }),
        qte_reseau,
        ca_reseau: 0.0,
        nb_magasins_reseau: nb_mag,
        taux_presence: nb_mag / NB_MAGASINS_RESEAU,
        qte_par_magasin_reseau: if nb_mag > 0.0 { qte_reseau / nb_mag } else { 0.0 },
        ca_par_magasin_reseau: 0.0,
        prix_moyen_reseau: None,
        marge_pct_reseau: None,
        qte_by_month: None,
        nb_mag_by_month: None,
        periode: None,
    }
}

/// Traduit les pannes Qlik récurrentes en message actionnable. Les autres
/// erreurs sont renvoyées telles quelles (tronquées) pour rester diagnosticables.
pub fn message_qlik_lisible(message: &str) -> String {
    static CODE_15: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#""code"\s*:\s*15\b"#).expect("regex"));
    let lower = message.to_lowercase();
    if lower.contains("out of memory") || lower.contains("not enough memory") || lower.contains("\"code\":6") || lower.contains("\"code\":3002")
    {
        return "Serveur Qlik saturé : mémoire insuffisante pour charger l'application. Réessayez plus tard.".into();
    }
    if CODE_15.is_match(message) || lower.contains("request aborted") {
        return "Qlik a interrompu la requête (recherche trop large pour le moteur). Ajoutez un mot plus précis, puis relancez.".into();
    }
    if lower.contains("identifiants qlik manquants") || lower.contains("qlik_user") {
        return "Identifiants Qlik non configurés (Paramètres → Qlik).".into();
    }
    if lower.contains("timeout") || lower.contains("econnrefused") || lower.contains("enotfound") {
        return "Serveur Qlik injoignable depuis CollectFlow (réseau ou VPN).".into();
    }
    slice_js(message, 300)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_complet(now: NaiveDate, periode: &str) -> NetworkMetricCached {
        NetworkMetricCached {
            qte_by_month: Some(build_rolling12_qlik_months(now).into_iter().map(|m| (m, 1.0)).collect()),
            periode: Some(periode.into()),
            ..Default::default()
        }
    }

    #[test]
    fn cle_de_cache_normalisee() {
        assert_eq!(cache_key("  Tapis   ANTI\tpoussière "), "tapis anti poussière");
    }

    #[test]
    fn cache_reseau_complet_exige_periode_et_12_mois() {
        let now = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();
        let c = cache_complet(now, "2025-03_2026-02");
        assert!(cache_reseau_complet(Some(&c), Some("2025-03_2026-02"), now));
        // Période différente, absente, ou cache absent.
        assert!(!cache_reseau_complet(Some(&c), Some("2025-02_2026-01"), now));
        assert!(!cache_reseau_complet(Some(&c), None, now));
        assert!(!cache_reseau_complet(None, Some("2025-03_2026-02"), now));
        // Un mois manquant ou non fini.
        let mut trou = c.clone();
        trou.qte_by_month.as_mut().unwrap().remove("2025-07");
        assert!(!cache_reseau_complet(Some(&trou), Some("2025-03_2026-02"), now));
        let mut nan = c.clone();
        nan.qte_by_month.as_mut().unwrap().insert("2025-07".into(), f64::NAN);
        assert!(!cache_reseau_complet(Some(&nan), Some("2025-03_2026-02"), now));
        // Sans qteByMonth.
        let mut vide = c;
        vide.qte_by_month = None;
        assert!(!cache_reseau_complet(Some(&vide), Some("2025-03_2026-02"), now));
    }

    #[test]
    fn nb_mag_par_mois_zero_si_absent() {
        let mut m = BTreeMap::new();
        m.insert("2025-03".to_string(), QlikMonthMetrics { qte: 4.0, nb_mag: Some(3.0), ..Default::default() });
        m.insert("2025-04".to_string(), QlikMonthMetrics { qte: 0.0, nb_mag: None, ..Default::default() });
        let r = nb_mag_par_mois(Some(&m)).unwrap();
        assert_eq!(r["2025-03"], 3.0);
        assert_eq!(r["2025-04"], 0.0);
        assert_eq!(nb_mag_par_mois(Some(&BTreeMap::new())), None);
        assert_eq!(nb_mag_par_mois(None), None);
    }

    #[test]
    fn messages_qlik_lisibles() {
        assert!(message_qlik_lisible("Engine: Out of memory").starts_with("Serveur Qlik saturé"));
        assert!(message_qlik_lisible(r#"{"code":3002}"#).starts_with("Serveur Qlik saturé"));
        assert!(message_qlik_lisible(r#"{"code": 15, "message":"x"}"#).starts_with("Qlik a interrompu"));
        assert!(message_qlik_lisible("Request aborted").starts_with("Qlik a interrompu"));
        assert!(message_qlik_lisible("Identifiants Qlik manquants").starts_with("Identifiants Qlik non configurés"));
        assert!(message_qlik_lisible("connect ECONNREFUSED 10.0.0.1").starts_with("Serveur Qlik injoignable"));
        // `"code":150` n'est pas le code 15.
        assert_eq!(message_qlik_lisible(r#"{"code":150}"#), r#"{"code":150}"#);
        let long = "é".repeat(400);
        assert_eq!(message_qlik_lisible(&long).chars().count(), 300);
    }

    #[test]
    fn tri_par_quantite_reseau_puis_libelle() {
        let ligne = |libelle: &str, qte: f64| ProduitRechercheRow { libelle: libelle.into(), qte_reseau: qte, ..Default::default() };
        let mut rows = vec![ligne("b", 5.0), ligne("Éa", 10.0), ligne("a", 10.0), ligne("z", f64::NAN), ligne("c", 0.0)];
        trier_lignes(&mut rows);
        let ordre: Vec<&str> = rows.iter().map(|r| r.libelle.as_str()).collect();
        assert_eq!(ordre, vec!["a", "Éa", "b", "c", "z"]);
    }

    #[test]
    fn ligne_catalogue_seul() {
        let r = PgProduitSearchRow {
            codein: "123".into(),
            code_centrale: "10000167303".into(),
            libelle1: String::new(),
            fournisseur: "ACME".into(),
            nomenclature: "Cuisine".into(),
            stock_total: 7.0,
            qte_reseau: 54.0,
            nb_magasins_reseau: 27,
            ..Default::default()
        };
        let v = serde_json::to_value(row_depuis_catalogue_seul(&r)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "codeCentrale": "10000167303",
                "libelle": "123",
                "libelleReseau": "",
                "fournisseur": "ACME",
                "codein": "123",
                "nomenclature": "Cuisine",
                "stockLocal": 7,
                "qteReseau": 54,
                "caReseau": 0,
                "nbMagasinsReseau": 27,
                "tauxPresence": 0.1,
                "qteParMagasinReseau": 2,
                "caParMagasinReseau": 0,
                "prixMoyenReseau": null,
                "margePctReseau": null,
                "qteByMonth": null,
                "nbMagByMonth": null,
                "periode": null,
            })
        );
    }

    #[test]
    fn etat_idle_et_job_serialises() {
        let idle = RechercheEtat::Idle { terme: "poêle".into() }.reponse();
        assert_eq!(idle, serde_json::json!({ "success": true, "status": "idle", "terme": "poêle" }));

        let job = RechercheJob {
            job_id: "rech_x".into(),
            terme: "poêle".into(),
            status: StatutRecherche::Running,
            etape: "Recherche des articles dans Qlik…".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
            finished_at: None,
            error: None,
            result: None,
            termine: None,
        };
        let v = RechercheEtat::Job(job).reponse();
        assert_eq!(
            v,
            serde_json::json!({
                "success": true,
                "jobId": "rech_x",
                "terme": "poêle",
                "status": "running",
                "etape": "Recherche des articles dans Qlik…",
                "startedAt": "2026-01-01T00:00:00.000Z",
            })
        );
    }

    #[test]
    fn base36_comme_js() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(alea_base36().len(), 6);
    }
}
