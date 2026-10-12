//! Schéma de la base, joué à chaque démarrage (idempotent).

const INIT_SQL: &str = include_str!("../sql/init.sql");

pub async fn run() {
    tracing::info!("[DB Init] Starting database migration & initialization...");
    let pool = match crate::db::pool() {
        Ok(p) => p,
        Err(_) => {
            tracing::warn!("[DB Init] No DATABASE_URL found in env or config. Skipping.");
            return;
        }
    };
    match sqlx::raw_sql(INIT_SQL).execute(&pool).await {
        Ok(_) => tracing::info!("[DB Init] Initialization successful."),
        // L'application reste utilisable (comptes de secours, Paramètres).
        Err(e) => tracing::error!("[DB Init] Initialization failed: {e}"),
    }
}
