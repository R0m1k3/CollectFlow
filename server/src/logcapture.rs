//! Capture des journaux serveur d'un job, pour téléchargement.
//!
//! Les extractions Qlik produisent des milliers de lignes ; la sortie standard
//! du conteneur les tronque. Tant qu'au moins une capture est ouverte, chaque
//! ligne journalisée (par n'importe quel code du processus) y est recopiée, puis
//! écrite sur disque au fil de l'eau (toutes les 2 s au plus).
//!
//! ⚠️ Deux jobs simultanés partagent les journaux du processus : chaque capture
//! ouverte reçoit TOUTES les lignes de la période.

use chrono::Utc;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{Instant, SystemTime};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const MAX_LIGNES: usize = 200_000;
const MAX_LONGUEUR_LIGNE: usize = 8_000;
const MAX_FICHIERS: usize = 20;
const FLUSH_MS: u128 = 2_000;

struct Capture {
    lignes: Vec<String>,
    tronque: bool,
    debut: Instant,
    dernier_flush: Option<Instant>,
    ecrites: usize,
}

static CAPTURES: LazyLock<Mutex<HashMap<String, Capture>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn log_dir() -> PathBuf {
    std::env::temp_dir().join("collectflow-logs")
}

fn nom_sur(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || "_.-".contains(c) { c } else { '_' }).collect()
}

fn fichier_pour(id: &str) -> PathBuf {
    log_dir().join(format!("{}.log", nom_sur(id)))
}

fn horodatage() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Écrit sur disque les lignes pas encore écrites (synchrone, appelé sous verrou).
fn flush(id: &str, c: &mut Capture) {
    let _ = std::fs::create_dir_all(log_dir());
    let total = c.lignes.len();
    if c.ecrites == 0 || total > c.ecrites {
        let nouvelles = &c.lignes[c.ecrites..total];
        let mut texte = nouvelles.join("\n");
        texte.push('\n');
        let res = if c.ecrites == 0 {
            std::fs::write(fichier_pour(id), texte)
        } else {
            std::fs::OpenOptions::new()
                .append(true)
                .open(fichier_pour(id))
                .and_then(|mut f| f.write_all(texte.as_bytes()))
        };
        if res.is_ok() {
            c.ecrites = total;
        }
    }
    c.dernier_flush = Some(Instant::now());
}

/// Ajoute une ligne à toutes les captures ouvertes.
pub fn ajouter(ligne: &str) {
    let mut captures = CAPTURES.lock();
    if captures.is_empty() {
        return;
    }
    let texte = if ligne.len() > MAX_LONGUEUR_LIGNE {
        let mut cut = MAX_LONGUEUR_LIGNE;
        while !ligne.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{} …[ligne tronquée]", &ligne[..cut])
    } else {
        ligne.to_string()
    };
    let prefixe = format!("[{}] ", horodatage());
    for (id, c) in captures.iter_mut() {
        if c.lignes.len() >= MAX_LIGNES {
            if !c.tronque {
                c.tronque = true;
                c.lignes.push(format!("{prefixe}[log-capture] limite de {MAX_LIGNES} lignes atteinte — suite non enregistrée"));
            }
            continue;
        }
        c.lignes.push(format!("{prefixe}{texte}"));
        if c.dernier_flush.map(|t| t.elapsed().as_millis() >= FLUSH_MS).unwrap_or(true) {
            flush(id, c);
        }
    }
}

fn purger() {
    let Ok(rd) = std::fs::read_dir(log_dir()) else { return };
    let mut fichiers: Vec<(PathBuf, SystemTime)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".log"))
        .map(|e| (e.path(), e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)))
        .collect();
    if fichiers.len() <= MAX_FICHIERS {
        return;
    }
    fichiers.sort_by(|a, b| b.1.cmp(&a.1));
    for (p, _) in fichiers.into_iter().skip(MAX_FICHIERS) {
        let _ = std::fs::remove_file(p);
    }
}

/// Ouvre une capture : toutes les lignes journalisées à partir de maintenant y
/// sont recopiées jusqu'à [`stop_capture`].
pub fn start_capture(id: &str, entete: Option<&str>) {
    let mut c = Capture { lignes: Vec::new(), tronque: false, debut: Instant::now(), dernier_flush: None, ecrites: 0 };
    c.lignes.push(format!("[{}] [log-capture] début de capture {id}", horodatage()));
    if let Some(e) = entete {
        c.lignes.push(format!("[{}] [log-capture] {e}", horodatage()));
    }
    flush(id, &mut c);
    CAPTURES.lock().insert(id.to_string(), c);
    purger();
}

/// Ferme la capture et écrit son état final sur disque.
pub fn stop_capture(id: &str, pied: Option<&str>) {
    let Some(mut c) = CAPTURES.lock().remove(id) else { return };
    let duree = c.debut.elapsed().as_secs();
    let n = c.lignes.len();
    c.lignes.push(format!("[{}] [log-capture] fin de capture {id} — {n} lignes, {duree} s", horodatage()));
    if let Some(p) = pied {
        c.lignes.push(format!("[{}] [log-capture] {p}", horodatage()));
    }
    flush(id, &mut c);
}

/// Contenu d'un journal : la capture en cours, sinon le fichier sur disque.
pub fn read_capture(id: &str) -> Option<String> {
    if let Some(c) = CAPTURES.lock().get(id) {
        return Some(c.lignes.join("\n") + "\n");
    }
    std::fs::read_to_string(fichier_pour(id)).ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub id: String,
    pub octets: u64,
    pub modifie_le: String,
    pub en_cours: bool,
}

/// Journaux disponibles, du plus récent au plus ancien.
pub fn list_captures() -> Vec<CaptureInfo> {
    let en_cours: Vec<String> = CAPTURES.lock().keys().cloned().collect();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(log_dir()) {
        for e in rd.filter_map(|e| e.ok()) {
            let nom = e.file_name().to_string_lossy().to_string();
            let Some(id) = nom.strip_suffix(".log") else { continue };
            let Ok(meta) = e.metadata() else { continue };
            let modifie: chrono::DateTime<Utc> = meta.modified().map(Into::into).unwrap_or_else(|_| Utc::now());
            out.push(CaptureInfo {
                id: id.to_string(),
                octets: meta.len(),
                modifie_le: modifie.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
                en_cours: en_cours.iter().any(|x| nom_sur(x) == id),
            });
        }
    }
    out.sort_by(|a, b| b.modifie_le.cmp(&a.modifie_le));
    out
}

// ---------------------------------------------------------------------------
// Couche `tracing` qui alimente les captures
// ---------------------------------------------------------------------------

pub struct CaptureLayer;

struct MessageVisitor(String);

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value}", field.name());
        }
    }
}

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        // Aucune capture ouverte (le cas courant) : on ne formate rien.
        if CAPTURES.lock().is_empty() {
            return;
        }
        let mut v = MessageVisitor(String::new());
        event.record(&mut v);
        ajouter(&v.0);
    }
}
