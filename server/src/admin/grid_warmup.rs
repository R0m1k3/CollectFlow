//! Préchauffage de l'instantané de grille (`grid_rows`).
//!
//! L'API `/api/v1` ne calcule jamais : elle lit un instantané écrit quand la
//! Grille est ouverte. Sans préchauffage, un consommateur externe ne verrait que
//! les fournisseurs déjà consultés à la main. Ce job calcule chaque fournisseur
//! une fois, séquentiellement (le calcul est lourd en SQL).

use crate::auth::AdminUser;
use axum::extract::Query;
use axum::Json;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WarmupJob {
    /// "idle" | "running" | "success" | "error"
    status: &'static str,
    total: usize,
    done: usize,
    skipped: usize,
    failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_fournisseur: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    last_errors: Vec<String>,
}

impl WarmupJob {
    fn idle() -> Self {
        Self {
            status: "idle",
            total: 0,
            done: 0,
            skipped: 0,
            failed: 0,
            current_fournisseur: None,
            started_at: None,
            finished_at: None,
            error: None,
            last_errors: vec![],
        }
    }
}

static JOB: LazyLock<Arc<Mutex<Option<WarmupJob>>>> = LazyLock::new(|| Arc::new(Mutex::new(None)));

fn public_job() -> Value {
    let job = JOB.lock().clone().unwrap_or_else(WarmupJob::idle);
    let mut v = serde_json::to_value(job).unwrap_or(json!({}));
    v["success"] = json!(true);
    v
}

fn maintenant() -> String {
    crate::db::iso_utc(chrono::Utc::now())
}

fn maj(f: impl FnOnce(&mut WarmupJob)) {
    if let Some(j) = JOB.lock().as_mut() {
        f(j);
    }
}

async fn run_warmup(stale_hours: f64) {
    let res: anyhow::Result<()> = async {
        let fournisseurs = crate::ff::pg::pg_get_fournisseurs(None).await;
        // Les fournisseurs calculés récemment sont sautés : un second passage ne
        // coûte presque rien, le bouton est rejouable sans crainte.
        let existing = crate::grid::store::list_grid_suppliers().await?;
        let fresh_limit = chrono::Utc::now().naive_utc() - chrono::Duration::milliseconds((stale_hours * 3_600_000.0) as i64);
        let fresh: HashSet<String> = existing
            .iter()
            .filter(|s| s.computed_at_naive().map(|d| d > fresh_limit).unwrap_or(false))
            .map(|s| s.code_fournisseur.clone())
            .collect();
        maj(|j| j.total = fournisseurs.len());
        tracing::info!("[grid-warmup] {} fournisseurs, {} déjà à jour (< {}h)", fournisseurs.len(), fresh.len(), stale_hours);

        for f in &fournisseurs {
            if fresh.contains(&f.code) {
                maj(|j| j.skipped += 1);
                continue;
            }
            maj(|j| j.current_fournisseur = Some(format!("{} — {}", f.code, f.nom)));
            match crate::grid::product_rows::get_product_rows_for_sync(&f.code).await {
                Ok(_) => maj(|j| j.done += 1),
                Err(e) => {
                    let msg = format!("{}: {}", f.code, crate::error::short(&e, 120));
                    tracing::error!("[grid-warmup] {msg}");
                    maj(|j| {
                        j.failed += 1;
                        if j.last_errors.len() < 10 {
                            j.last_errors.push(msg);
                        }
                    });
                }
            }
        }
        Ok(())
    }
    .await;
    match res {
        Ok(()) => {
            maj(|j| {
                j.current_fournisseur = None;
                j.status = "success";
                j.finished_at = Some(maintenant());
            });
            if let Some(j) = JOB.lock().as_ref() {
                tracing::info!("[grid-warmup] terminé — {} calculés, {} à jour, {} en échec", j.done, j.skipped, j.failed);
            }
        }
        Err(e) => {
            let msg = format!("{e:#}");
            tracing::error!("[grid-warmup] échec global: {msg}");
            maj(|j| {
                j.status = "error";
                j.error = Some(msg);
                j.finished_at = Some(maintenant());
            });
        }
    }
}

/// GET /api/admin/grid-warmup — avancement du préchauffage.
pub async fn get(_admin: AdminUser) -> Json<Value> {
    Json(public_job())
}

/// POST /api/admin/grid-warmup?staleHours=24 — démarre en arrière-plan.
pub async fn post(_admin: AdminUser, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    {
        let mut job = JOB.lock();
        if job.as_ref().map(|j| j.status == "running").unwrap_or(false) {
            drop(job);
            return Json(public_job());
        }
        // Comme `Number(param)` : absent ou vide → 0, illisible → défaut 24 h.
        let raw = q
            .get("staleHours")
            .map(|s| if s.trim().is_empty() { 0.0 } else { s.trim().parse::<f64>().unwrap_or(f64::NAN) })
            .unwrap_or(0.0);
        let stale_hours = if raw.is_finite() { raw.clamp(0.0, 720.0) } else { 24.0 };
        *job = Some(WarmupJob { status: "running", started_at: Some(maintenant()), ..WarmupJob::idle() });
        tracing::info!("[grid-warmup] démarré (staleHours={stale_hours})");
        tokio::spawn(run_warmup(stale_hours));
    }
    Json(public_job())
}
