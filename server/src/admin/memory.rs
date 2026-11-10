//! Diagnostic mémoire : `GET /api/admin/memory` (administrateurs).
//!
//! Le conteneur dépassait 2,5 Go sans qu'on sache quoi : cette route donne la
//! mémoire vue par l'allocateur et le remplissage de chaque cache.

use crate::auth::AdminUser;
use axum::Json;
use serde_json::{json, Value};
use std::time::Duration;

fn mo(octets: usize) -> f64 {
    (octets as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

/// Mémoire résidente du processus (`VmRSS`, Linux), en octets.
fn rss_processus() -> Option<usize> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let ligne = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let ko: usize = ligne.split_whitespace().nth(1)?.parse().ok()?;
    Some(ko * 1024)
}

/// Statistiques jemalloc (octets) : (alloués, actifs, résidents, conservés).
fn jemalloc() -> Option<(usize, usize, usize, usize)> {
    use tikv_jemalloc_ctl::{epoch, stats};
    epoch::advance().ok()?;
    Some((stats::allocated::read().ok()?, stats::active::read().ok()?, stats::resident::read().ok()?, stats::retained::read().ok()?))
}

/// État mémoire courant (aussi écrit dans les journaux après la synchro).
pub fn etat() -> Value {
    let (grilles, lignes, calculs) = crate::grid::rows_cache::stats();
    let (ff_prets, ff_en_cours) = crate::ff_cache::stats();
    let alloc = jemalloc().map(|(a, ac, r, re)| json!({ "allocatedMo": mo(a), "activeMo": mo(ac), "residentMo": mo(r), "retainedMo": mo(re) }));
    json!({
        "processRssMo": rss_processus().map(mo),
        "jemalloc": alloc,
        "gridCache": { "grilles": grilles, "lignes": lignes, "calculsEnCours": calculs },
        "ffCache": { "entrees": ff_prets, "enCours": ff_en_cours },
        "rechercheProduitCache": crate::produits::search::cache_len(),
        "chromiumLance": crate::qlik::browser::chromium_actif(),
        // Purge de fond de jemalloc (réglage `_rjem_malloc_conf` de main.rs).
        "jemallocPurgeDeFond": tikv_jemalloc_ctl::background_thread::read().ok(),
    })
}

/// GET /api/admin/memory
pub async fn get(_admin: AdminUser) -> Json<Value> {
    Json(etat())
}

/// Purge périodique des caches expirés (toutes les minutes).
pub fn demarrer_purge() {
    tokio::spawn(async {
        let mut tic = tokio::time::interval(Duration::from_secs(60));
        loop {
            tic.tick().await;
            crate::grid::rows_cache::purger_expirees();
            crate::ff_cache::purger_expirees();
        }
    });
}
