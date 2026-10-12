//! Synchronisation nocturne des fournisseurs.
//!
//! Deux sources aux coûts très différents, donc deux files distinctes :
//!   • **SQL** — l'instantané de grille (`get_product_rows`), ~43 s sur le plus
//!     gros fournisseur. Alimente la Grille et `/api/v1`.
//!   • **Qlik** — les métriques réseau, jusqu'à 8 min par fournisseur, sur un
//!     serveur externe qui abandonne quand on le sollicite trop. Agrégats
//!     mensuels : les rafraîchir chaque nuit n'apporterait rien.
//!
//! ORDRE DE PASSAGE — la file est « le plus ancien d'abord », en ignorant ceux
//! déjà traités depuis l'ouverture de la fenêtre courante. Sans curseur ni
//! compteur de tour :
//!   • la nuit 2 reprend là où la nuit 1 s'est arrêtée ;
//!   • quand plus personne n'est en attente, le tour est fini ; la nuit
//!     suivante tout le monde redevient éligible ;
//!   • un fournisseur en échec garde une date ancienne : il repasse en tête.
//!
//! La fenêtre ne peut pas interrompre un fournisseur en cours : elle signifie
//! « ne plus en **démarrer** après l'heure de fin ».

use super::sync_settings::{read_sync_settings, SyncSettings};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, TimeZone, Timelike};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use sqlx::Row;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Instant;

// ─── État courant, en mémoire ────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSchedulerState {
    pub en_cours: bool,
    /// "auto" = déclenché par la fenêtre nocturne, "manuel" = lancé depuis l'admin.
    pub origine: Option<&'static str>,
    pub debut_at: Option<String>,
    pub fin_at: Option<String>,
    pub fournisseur_courant: Option<String>,
    pub etape: Option<&'static str>,
    pub sql_faits: u32,
    pub sql_echecs: u32,
    pub qlik_faits: u32,
    pub qlik_echecs: u32,
    /// Renseigné quand la file s'est vidée : le tour est bouclé.
    pub tour_termine: bool,
    pub arret_demande: bool,
    pub derniere_erreur: Option<String>,
}

static ETAT: LazyLock<Mutex<SyncSchedulerState>> = LazyLock::new(|| Mutex::new(SyncSchedulerState::default()));

pub fn get_sync_scheduler_state() -> SyncSchedulerState {
    ETAT.lock().clone()
}

pub fn demander_arret() {
    let mut e = ETAT.lock();
    if e.en_cours {
        e.arret_demande = true;
    }
}

fn iso_local(d: DateTime<Local>) -> String {
    crate::db::iso_utc(d.with_timezone(&chrono::Utc))
}

// ─── Fenêtre horaire ─────────────────────────────────────────────────────────

fn a_heure(maintenant: DateTime<Local>, heure: i64) -> DateTime<Local> {
    let naive = maintenant.date_naive().and_hms_opt(heure.clamp(0, 23) as u32, 0, 0).unwrap();
    Local.from_local_datetime(&naive).earliest().unwrap_or(maintenant)
}

/// Début de la fenêtre en cours, ou `None` si l'heure courante est en dehors.
///
/// Gère le passage par minuit (ex. 22h → 5h) : entre 0h et l'heure de fin, la
/// fenêtre a commencé **la veille**.
pub fn debut_fenetre(s: &SyncSettings, maintenant: DateTime<Local>) -> Option<DateTime<Local>> {
    let h = maintenant.hour() as i64;
    let debut_du_jour = a_heure(maintenant, s.heure_debut);
    if s.heure_debut < s.heure_fin {
        return (h >= s.heure_debut && h < s.heure_fin).then_some(debut_du_jour);
    }
    // Fenêtre à cheval sur minuit.
    if h >= s.heure_debut {
        return Some(debut_du_jour);
    }
    if h < s.heure_fin {
        return Some(debut_du_jour - Duration::days(1));
    }
    None
}

// ─── Référentiel des fournisseurs ────────────────────────────────────────────

/// Aligne la table de paramétrage sur le référentiel FF : ajoute les nouveaux
/// fournisseurs (actifs par défaut), rafraîchit les noms. Ne supprime rien.
pub async fn seed_sync_fournisseurs() -> anyhow::Result<usize> {
    let fournisseurs = crate::ff::pg::pg_get_fournisseurs(None).await;
    if fournisseurs.is_empty() {
        return Ok(0);
    }
    let pool = crate::db::pool()?;
    for lot in fournisseurs.chunks(500) {
        let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new("INSERT INTO sync_fournisseurs (code_fournisseur, nom_fournisseur) ");
        qb.push_values(lot, |mut b, f| {
            b.push_bind(&f.code).push_bind(&f.nom);
        });
        // Seul le nom est réaligné : les choix d'activation appartiennent à l'admin.
        qb.push(" ON CONFLICT (code_fournisseur) DO UPDATE SET nom_fournisseur = excluded.nom_fournisseur");
        qb.build().execute(&pool).await?;
    }
    Ok(fournisseurs.len())
}

// ─── Files d'attente ─────────────────────────────────────────────────────────

struct Cible {
    code: String,
    nom: Option<String>,
}

fn cible(r: &sqlx::postgres::PgRow) -> Cible {
    Cible { code: r.try_get("code_fournisseur").unwrap_or_default(), nom: r.try_get("nom_fournisseur").ok().flatten() }
}

fn naive(d: DateTime<Local>) -> NaiveDateTime {
    // Colonnes `timestamp` sans fuseau, écrites par `now()` du serveur (UTC) :
    // on compare en UTC.
    d.with_timezone(&chrono::Utc).naive_utc()
}

/// Le plus ancien fournisseur SQL pas encore traité depuis l'ouverture de la fenêtre.
async fn prochain_sql(depuis: DateTime<Local>) -> anyhow::Result<Option<Cible>> {
    let pool = crate::db::pool()?;
    let row = sqlx::query(
        "SELECT code_fournisseur, nom_fournisseur FROM sync_fournisseurs
         WHERE actif_sql = true AND (dernier_sql_at IS NULL OR dernier_sql_at < $1)
         ORDER BY dernier_sql_at ASC NULLS FIRST LIMIT 1",
    )
    .bind(naive(depuis))
    .fetch_optional(&pool)
    .await?;
    Ok(row.as_ref().map(cible))
}

/// Délai avant de retenter un fournisseur Qlik en échec : la nuit suivante.
const QLIK_REPRISE_ECHEC_H: i64 = 18;

/// Le plus ancien fournisseur Qlik à rafraîchir : données plus vieilles que
/// `qlikMinJours`, ou d'avant le mois en cours (la fenêtre de 12 mois a glissé),
/// ou dernière extraction en échec il y a plus de 18 h.
async fn prochain_qlik(qlik_min_jours: i64, maintenant: DateTime<Local>) -> anyhow::Result<Option<Cible>> {
    let seuil_age = maintenant - Duration::days(qlik_min_jours);
    let debut_mois = Local
        .from_local_datetime(&maintenant.date_naive().with_day(1).unwrap().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap_or(maintenant);
    let seuil = if seuil_age > debut_mois { seuil_age } else { debut_mois };
    let seuil_echec = maintenant - Duration::hours(QLIK_REPRISE_ECHEC_H);
    let pool = crate::db::pool()?;
    let row = sqlx::query(
        "SELECT code_fournisseur, nom_fournisseur FROM sync_fournisseurs
         WHERE actif_qlik = true AND (
             dernier_qlik_at IS NULL
             OR dernier_qlik_at < $1
             OR (dernier_qlik_statut = 'echec' AND dernier_qlik_at < $2)
         )
         ORDER BY dernier_qlik_at ASC NULLS FIRST LIMIT 1",
    )
    .bind(naive(seuil))
    .bind(naive(seuil_echec))
    .fetch_optional(&pool)
    .await?;
    Ok(row.as_ref().map(cible))
}

// ─── Traitement d'un fournisseur ─────────────────────────────────────────────

fn libelle(code: &str, nom: &Option<String>) -> String {
    match nom {
        Some(n) if !n.is_empty() => format!("{code} — {n}"),
        _ => code.to_string(),
    }
}

fn tronque(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Instantané SQL. `dernier_sql_at` est renseigné **même en cas d'échec** :
/// sans cela, un fournisseur en échec resterait le plus ancien et bloquerait la file.
async fn traiter_sql(code: &str, nom: &Option<String>) {
    let t0 = Instant::now();
    {
        let mut e = ETAT.lock();
        e.fournisseur_courant = Some(libelle(code, nom));
        e.etape = Some("sql");
    }
    let res = crate::grid::product_rows::get_product_rows_for_sync(code).await;
    let ms = t0.elapsed().as_millis() as i32;
    let pool = match crate::db::pool() {
        Ok(p) => p,
        Err(_) => return,
    };
    match res {
        Ok(n) => {
            let vide = n == 0;
            // Un fournisseur sans article n'a rien à donner : on le sort des deux
            // files plutôt que de le réessayer chaque nuit (motif visible par l'admin).
            let sql = if vide {
                "UPDATE sync_fournisseurs SET dernier_sql_at = now(), dernier_sql_statut = 'vide', dernier_sql_lignes = $2,
                 dernier_sql_erreur = NULL, dernier_sql_ms = $3, actif_sql = false, actif_qlik = false,
                 desactive_motif = 'Aucun article — désactivé automatiquement', updated_at = now() WHERE code_fournisseur = $1"
            } else {
                "UPDATE sync_fournisseurs SET dernier_sql_at = now(), dernier_sql_statut = 'succes', dernier_sql_lignes = $2,
                 dernier_sql_erreur = NULL, dernier_sql_ms = $3, updated_at = now() WHERE code_fournisseur = $1"
            };
            if let Err(e) = sqlx::query(sql).bind(code).bind(n as i32).bind(ms).execute(&pool).await {
                tracing::error!("[sync-nuit] suivi SQL {code} non écrit : {e}");
            }
            if vide {
                tracing::info!("[sync-nuit] {code} sans article — désactivé automatiquement");
            } else {
                ETAT.lock().sql_faits += 1;
            }
        }
        Err(err) => {
            let msg = format!("{err:#}");
            {
                let mut e = ETAT.lock();
                e.sql_echecs += 1;
                e.derniere_erreur = Some(format!("{code} (SQL) : {msg}"));
            }
            tracing::error!("[sync-nuit] SQL {code} en échec : {msg}");
            let _ = sqlx::query(
                "UPDATE sync_fournisseurs SET dernier_sql_at = now(), dernier_sql_statut = 'echec', dernier_sql_erreur = $2,
                 dernier_sql_ms = $3, updated_at = now() WHERE code_fournisseur = $1",
            )
            .bind(code)
            .bind(tronque(&msg, 500))
            .bind(ms)
            .execute(&pool)
            .await;
        }
    }
}

/// Format d'un code centrale plausible — même filtre que la synchro manuelle.
static CODE_CENTRALE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[A-Z0-9][A-Z0-9_-]{1,29}$").unwrap());

/// Extraction Qlik. Même politique que le SQL sur l'horodatage en cas d'échec.
async fn traiter_qlik(code: &str, nom: &Option<String>) {
    let t0 = Instant::now();
    {
        let mut e = ETAT.lock();
        e.fournisseur_courant = Some(libelle(code, nom));
        e.etape = Some("qlik");
    }
    let res: anyhow::Result<Option<usize>> = async {
        let articles = crate::ff::pg::pg_get_articles_by_fournisseur(code).await?;
        let mut vus = HashSet::new();
        let codes: Vec<String> = articles
            .iter()
            .map(|a| a.code_centrale.clone().unwrap_or_default().trim().to_string())
            .filter(|c| !c.is_empty() && c != "-" && CODE_CENTRALE.is_match(c))
            .filter(|c| vus.insert(c.clone()))
            .collect();
        if codes.is_empty() {
            return Ok(None);
        }
        let n = super::qlik_bridge::extraire_et_enregistrer(codes, code).await?;
        Ok(Some(n))
    }
    .await;
    let ms = t0.elapsed().as_millis() as i32;
    let Ok(pool) = crate::db::pool() else { return };
    match res {
        Ok(None) => {
            let _ = sqlx::query(
                "UPDATE sync_fournisseurs SET dernier_qlik_at = now(), dernier_qlik_statut = 'vide', dernier_qlik_codes = 0,
                 dernier_qlik_erreur = NULL, dernier_qlik_ms = $2, updated_at = now() WHERE code_fournisseur = $1",
            )
            .bind(code)
            .bind(ms)
            .execute(&pool)
            .await;
        }
        Ok(Some(n)) => {
            let _ = sqlx::query(
                "UPDATE sync_fournisseurs SET dernier_qlik_at = now(), dernier_qlik_statut = 'succes', dernier_qlik_codes = $2,
                 dernier_qlik_erreur = NULL, dernier_qlik_ms = $3, updated_at = now() WHERE code_fournisseur = $1",
            )
            .bind(code)
            .bind(n as i32)
            .bind(ms)
            .execute(&pool)
            .await;
            ETAT.lock().qlik_faits += 1;
            tracing::info!("[sync-nuit] Qlik {code} — {n} codes en {} s", t0.elapsed().as_secs());
        }
        Err(err) => {
            let msg = format!("{err:#}");
            {
                let mut e = ETAT.lock();
                e.qlik_echecs += 1;
                e.derniere_erreur = Some(format!("{code} (Qlik) : {msg}"));
            }
            tracing::error!("[sync-nuit] Qlik {code} en échec : {msg}");
            let _ = sqlx::query(
                "UPDATE sync_fournisseurs SET dernier_qlik_at = now(), dernier_qlik_statut = 'echec', dernier_qlik_erreur = $2,
                 dernier_qlik_ms = $3, updated_at = now() WHERE code_fournisseur = $1",
            )
            .bind(code)
            .bind(tronque(&msg, 500))
            .bind(ms)
            .execute(&pool)
            .await;
        }
    }
}

// ─── Boucle de travail ───────────────────────────────────────────────────────

/// Traite les files jusqu'à épuisement, sortie de fenêtre, ou demande d'arrêt.
///
/// Les deux files avancent en parallèle : une extraction Qlik est intercalée
/// tous les `sqlParQlik` fournisseurs SQL. Sans cet entrelacement, Qlik ne
/// démarrerait jamais tant que la file SQL n'est pas vide.
pub async fn lancer_round(origine: &'static str, forcer_hors_fenetre: bool) {
    let s = read_sync_settings();
    let maintenant = Local::now();
    let debut = debut_fenetre(&s, maintenant);
    if !forcer_hors_fenetre && debut.is_none() {
        return;
    }
    {
        let mut e = ETAT.lock();
        if e.en_cours {
            return;
        }
        *e = SyncSchedulerState {
            en_cours: true,
            origine: Some(origine),
            debut_at: Some(iso_local(maintenant)),
            ..Default::default()
        };
    }
    // Un lancement manuel hors fenêtre borne la file sur « depuis ce matin ».
    let depuis = debut.unwrap_or_else(|| a_heure(maintenant, 0));
    tracing::info!("[sync-nuit] round {origine} démarré (fenêtre {}h-{}h, Qlik ≤ {})", s.heure_debut, s.heure_fin, s.qlik_par_nuit);

    let res: anyhow::Result<()> = async {
        seed_sync_fournisseurs().await?;

        // Garde anti-boucle : l'avancement de la file repose sur l'écriture de
        // `dernier*_at`, volontairement non bloquante en cas d'erreur.
        let mut tentes: HashSet<String> = HashSet::new();
        let mut depuis_dernier_qlik: i64 = 0;
        loop {
            if ETAT.lock().arret_demande {
                break;
            }
            if !forcer_hors_fenetre && debut_fenetre(&s, Local::now()).is_none() {
                tracing::info!("[sync-nuit] fin de fenêtre — arrêt après le fournisseur en cours");
                break;
            }
            let qlik_possible = {
                let e = ETAT.lock();
                ((e.qlik_faits + e.qlik_echecs) as i64) < s.qlik_par_nuit
            };

            // Qlik prioritaire quand le quota d'entrelacement est atteint.
            if qlik_possible && depuis_dernier_qlik >= s.sql_par_qlik {
                if let Some(c) = prochain_qlik(s.qlik_min_jours, Local::now()).await? {
                    if tentes.insert(format!("qlik:{}", c.code)) {
                        traiter_qlik(&c.code, &c.nom).await;
                        depuis_dernier_qlik = 0;
                        continue;
                    }
                }
            }

            if let Some(c) = prochain_sql(depuis).await? {
                if !tentes.insert(format!("sql:{}", c.code)) {
                    tracing::error!(
                        "[sync-nuit] {} ressort de la file après avoir été traité : le suivi n'a pas pu être écrit. Arrêt du round pour ne pas boucler.",
                        c.code
                    );
                    break;
                }
                traiter_sql(&c.code, &c.nom).await;
                depuis_dernier_qlik += 1;
                continue;
            }

            // File SQL vide : on consacre le temps restant à Qlik.
            if qlik_possible {
                if let Some(c) = prochain_qlik(s.qlik_min_jours, Local::now()).await? {
                    if tentes.insert(format!("qlik:{}", c.code)) {
                        traiter_qlik(&c.code, &c.nom).await;
                        depuis_dernier_qlik = 0;
                        continue;
                    }
                }
            }

            ETAT.lock().tour_termine = true;
            tracing::info!("[sync-nuit] plus rien en attente — tour terminé");
            break;
        }
        Ok(())
    }
    .await;

    if let Err(e) = res {
        let msg = format!("{e:#}");
        tracing::error!("[sync-nuit] round interrompu : {msg}");
        ETAT.lock().derniere_erreur = Some(msg);
    }
    // Les pages (stock, hit-parade, CA…) relisent la base fraîche.
    crate::ff_cache::invalidate();
    let e = {
        let mut e = ETAT.lock();
        e.en_cours = false;
        e.fournisseur_courant = None;
        e.etape = None;
        e.fin_at = Some(iso_local(Local::now()));
        e.clone()
    };
    tracing::info!(
        "[sync-nuit] round terminé — SQL {} ok / {} en échec, Qlik {} ok / {} en échec, tour bouclé={}",
        e.sql_faits,
        e.sql_echecs,
        e.qlik_faits,
        e.qlik_echecs,
        e.tour_termine
    );
}

/// Battement du minuteur : ne fait quelque chose que dans la fenêtre, et jamais
/// deux rounds à la fois. Silencieux hors fenêtre — appelé chaque minute.
pub async fn tick_scheduler() {
    let s = read_sync_settings();
    if !s.actif || ETAT.lock().en_cours {
        return;
    }
    if debut_fenetre(&s, Local::now()).is_none() {
        return;
    }
    lancer_round("auto", false).await;
}

/// Minuteur de la synchronisation nocturne : bat chaque minute et laisse
/// `tick_scheduler` décider s'il y a quelque chose à faire. Rien ne tourne si
/// l'application est arrêtée ; il se réarme tout seul au redémarrage.
pub fn start_sync_timer() {
    tracing::info!("[sync-nuit] minuteur démarré (battement 60 s)");
    tokio::spawn(async {
        let mut intervalle = tokio::time::interval(std::time::Duration::from_secs(60));
        intervalle.tick().await;
        loop {
            intervalle.tick().await;
            // Un round dure longtemps : il tourne dans sa propre tâche pour qu'une
            // panique éventuelle n'arrête pas le minuteur.
            if let Err(e) = tokio::spawn(tick_scheduler()).await {
                tracing::error!("[sync-nuit] battement en erreur : {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admin::sync_settings::SYNC_SETTINGS_DEFAUT;

    fn at(h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 10, h, 30, 0).unwrap()
    }

    #[test]
    fn fenetre_simple() {
        let s = SyncSettings { heure_debut: 1, heure_fin: 5, ..SYNC_SETTINGS_DEFAUT };
        assert!(debut_fenetre(&s, at(0)).is_none());
        assert_eq!(debut_fenetre(&s, at(3)).unwrap().hour(), 1);
        assert!(debut_fenetre(&s, at(5)).is_none());
    }

    #[test]
    fn fenetre_minuit() {
        let s = SyncSettings { heure_debut: 22, heure_fin: 5, ..SYNC_SETTINGS_DEFAUT };
        assert_eq!(debut_fenetre(&s, at(23)).unwrap().day(), 10);
        let d = debut_fenetre(&s, at(2)).unwrap();
        assert_eq!((d.day(), d.hour()), (9, 22));
        assert!(debut_fenetre(&s, at(12)).is_none());
    }
}
