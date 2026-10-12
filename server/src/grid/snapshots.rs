//! Snapshots de la Grille (port de `src/features/snapshots/api/*.ts`) :
//! actions `getSnapshots`, `deleteSnapshot`, `saveSnapshot`.
//!
//! `session_snapshots.user_id` est un entier : l'identifiant de session est lu
//! comme le faisait le TS (`parseInt`), et le compte de secours « 0 » ou un
//! identifiant non numérique travaillent sur les snapshots « anonymes »
//! (`user_id IS NULL`). Les `revalidatePath` de Next.js n'ont plus d'objet.

use super::session::{as_pg_integer, final_user_id, js_key_order, user_id_log, verifier_session};
use super::zod::{self, child, Issues, Seg};
use crate::db;
use crate::error::{AppError, AppResult};
use crate::rpc::{json, Ctx};
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{json as j, Map, Value};
use sqlx::{PgPool, Row};

/// Ligne de `session_snapshots`, telle que `db.select().from(sessionSnapshots)`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: i32,
    pub user_id: Option<i32>,
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub magasin: String,
    pub changes: Value,
    pub summary_json: Option<Value>,
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub created_at: Option<String>,
}

fn ligne_snapshot(r: &sqlx::postgres::PgRow) -> SessionSnapshot {
    SessionSnapshot {
        id: r.try_get("id").unwrap_or_default(),
        user_id: r.try_get("user_id").ok().flatten(),
        code_fournisseur: r.try_get("code_fournisseur").unwrap_or_default(),
        nom_fournisseur: r.try_get("nom_fournisseur").ok().flatten(),
        magasin: r.try_get("magasin").unwrap_or_default(),
        changes: r.try_get("changes").unwrap_or(Value::Null),
        summary_json: r.try_get("summary_json").ok().flatten(),
        label: r.try_get("label").ok().flatten(),
        type_: r.try_get("type").ok().flatten(),
        created_at: r.try_get::<Option<NaiveDateTime>, _>("created_at").ok().flatten().map(db::iso),
    }
}

// ---------------------------------------------------------------------------
// getSnapshots
// ---------------------------------------------------------------------------

/// Snapshots de l'utilisateur connecté (ou anonymes), du plus récent au plus ancien.
pub async fn lister_snapshots(user_raw_id: &str, type_: Option<&str>) -> Result<Vec<SessionSnapshot>, String> {
    let pool = db::pool().map_err(|e| e.message)?;
    // Si on a un userId, on filtre par celui-ci.
    // Sinon, on filtre par userId IS NULL (mode anonyme/local)
    let mut sql = String::from(
        "select id, user_id, code_fournisseur, nom_fournisseur, magasin, changes, summary_json, label, type, created_at \
         from session_snapshots where ",
    );
    let user_id = match final_user_id(user_raw_id) {
        Some(v) => Some(as_pg_integer(v)?),
        None => None,
    };
    sql.push_str(if user_id.is_some() { "user_id = $1" } else { "user_id is null" });
    if type_.is_some() {
        sql.push_str(if user_id.is_some() { " and type = $2" } else { " and type = $1" });
    }
    sql.push_str(" order by created_at desc");
    let mut q = sqlx::query(&sql);
    if let Some(id) = user_id {
        q = q.bind(id);
    }
    if let Some(t) = type_ {
        q = q.bind(t);
    }
    let rows = q.fetch_all(&pool).await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(ligne_snapshot).collect())
}

/// Action `getSnapshots(type?)`.
async fn get_snapshots(ctx: Ctx) -> AppResult<Value> {
    let utilisateur = ctx.session().await?;
    let arg = ctx.args.first();
    // `if (type)` : seule une valeur « vraie » filtre.
    let type_ = super::js::js_truthy(arg).then(|| super::js::js_string(arg));
    match lister_snapshots(&utilisateur.id, type_.as_deref()).await {
        Ok(rows) => json(rows),
        Err(msg) => {
            let premiere_ligne = msg.lines().next().unwrap_or_default().to_string();
            tracing::error!("[getSnapshots] ERROR (type={}): {premiere_ligne}", type_.as_deref().unwrap_or("undefined"));
            // Remonter l'erreur : une liste vide faisait afficher « Aucun snapshot »
            // au lieu de signaler que le chargement a échoué.
            Err(AppError::internal("Chargement de l'historique impossible."))
        }
    }
}

// ---------------------------------------------------------------------------
// deleteSnapshot
// ---------------------------------------------------------------------------

/// Supprime un snapshot de l'utilisateur (ou anonyme). Résultat `{ success, error? }`.
pub async fn supprimer_snapshot(user_raw_id: &str, id: &Value) -> Value {
    tracing::info!("[deleteSnapshot] Request for ID: {}, Session UserId: {}", super::js::js_string(Some(id)), user_id_log(user_raw_id));

    let res: Result<u64, String> = async {
        let pool = db::pool().map_err(|e| e.message)?;
        // Condition de sécurité : match ID ET match le propriétaire (ou anonyme)
        let user_id = match final_user_id(user_raw_id) {
            Some(v) => Some(as_pg_integer(v)?),
            None => None,
        };
        let id_sql: Option<i32> = match id {
            Value::Null => None,
            Value::Number(n) => Some(as_pg_integer(n.as_f64().unwrap_or(f64::NAN))?),
            Value::String(s) => Some(s.trim().parse::<i32>().map_err(|_| format!("invalid input syntax for type integer: \"{s}\""))?),
            autre => return Err(format!("invalid input syntax for type integer: {autre}")),
        };
        let sql = if user_id.is_some() {
            "delete from session_snapshots where (id = $1 and user_id = $2) returning id"
        } else {
            "delete from session_snapshots where (id = $1 and user_id is null) returning id"
        };
        let mut q = sqlx::query(sql).bind(id_sql);
        if let Some(u) = user_id {
            q = q.bind(u);
        }
        let rows = q.fetch_all(&pool).await.map_err(|e| e.to_string())?;
        Ok(rows.len() as u64)
    }
    .await;

    match res {
        Ok(0) => {
            tracing::warn!(
                "[deleteSnapshot] No rows deleted for ID {}. Snapshot may not exist or belongs to another user.",
                super::js::js_string(Some(id))
            );
            j!({ "success": false, "error": "Snapshot non trouvé ou non autorisé" })
        }
        Ok(_) => {
            tracing::info!("[deleteSnapshot] Successfully deleted ID: {}", super::js::js_string(Some(id)));
            j!({ "success": true })
        }
        Err(e) => {
            // Le détail technique reste dans les journaux du serveur.
            tracing::error!("[deleteSnapshot] DB Error: {e}");
            j!({ "success": false, "error": "erreur technique sur le serveur" })
        }
    }
}

/// Action `deleteSnapshot(id)`.
async fn delete_snapshot(ctx: Ctx) -> AppResult<Value> {
    let utilisateur = match verifier_session(&ctx).await? {
        Ok(u) => u,
        Err(message) => return Ok(j!({ "success": false, "error": message })),
    };
    Ok(supprimer_snapshot(&utilisateur.id, &ctx.raw(0)).await)
}

// ---------------------------------------------------------------------------
// saveSnapshot
// ---------------------------------------------------------------------------

/// Données validées de `SaveSnapshotSchema` (clés inconnues retirées, comme zod).
#[derive(Debug, Clone)]
pub struct SaveSnapshotInput {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub magasin: String,
    pub label: Option<String>,
    /// codein → `{ before, after }`.
    pub changes: Map<String, Value>,
    pub type_: Option<String>,
    /// `{ totalRows, totalCa, totalMarge, tauxMargeGlobal }`.
    pub summary: Option<Value>,
}

/// `SaveSnapshotSchema.safeParse(raw)`.
pub fn parse_save_snapshot(raw: &Value) -> Result<SaveSnapshotInput, Issues> {
    let mut issues = Issues::default();
    let racine: Vec<Seg> = vec![];
    let Some(o) = zod::object(Some(raw), &racine, &mut issues) else { return Err(issues) };
    let p = |k: &str| vec![Seg::from(k)];

    let code_fournisseur = zod::string(o.get("codeFournisseur"), &p("codeFournisseur"), &mut issues);
    let nom_fournisseur = zod::opt_string(o.get("nomFournisseur"), &p("nomFournisseur"), &mut issues);
    let magasin = zod::string(o.get("magasin"), &p("magasin"), &mut issues);
    let label = zod::opt_string(o.get("label"), &p("label"), &mut issues);

    let mut changes = Map::new();
    let chemin_changes = p("changes");
    match o.get("changes") {
        Some(Value::Object(m)) => {
            for (k, v) in js_key_order(m) {
                let chemin = child(&chemin_changes, k.as_str());
                let Some(entree) = zod::object(Some(v), &chemin, &mut issues) else { continue };
                let before = zod::nullable_string(entree.get("before"), &child(&chemin, "before"), &mut issues);
                let after = zod::string(entree.get("after"), &child(&chemin, "after"), &mut issues);
                if let (Some(before), Some(after)) = (before, after) {
                    changes.insert(k.clone(), j!({ "before": before, "after": after }));
                }
            }
        }
        autre => issues.invalid_type(&chemin_changes, "record", autre),
    }

    let type_ = match o.get("type") {
        None => Some(None),
        v => zod::enum_value(v, &["snapshot", "export"], &p("type"), None, &mut issues).map(Some),
    };

    let summary = match o.get("summary") {
        None => Some(None),
        v => {
            let chemin = p("summary");
            match zod::object(v, &chemin, &mut issues) {
                Some(s) => {
                    let mut out = Map::new();
                    let mut complet = true;
                    for k in ["totalRows", "totalCa", "totalMarge", "tauxMargeGlobal"] {
                        match zod::number(s.get(k), &child(&chemin, k), &mut issues) {
                            Some(_) => {
                                out.insert(k.to_string(), s[k].clone());
                            }
                            None => complet = false,
                        }
                    }
                    complet.then_some(Some(Value::Object(out)))
                }
                None => None,
            }
        }
    };

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(SaveSnapshotInput {
        code_fournisseur: code_fournisseur.unwrap_or_default(),
        nom_fournisseur: nom_fournisseur.flatten(),
        magasin: magasin.unwrap_or_default(),
        label: label.flatten(),
        changes,
        type_: type_.flatten(),
        summary: summary.flatten(),
    })
}

/// Date du jour façon `toLocaleDateString("fr-FR")`.
pub fn date_fr() -> String {
    chrono::Local::now().format("%d/%m/%Y").to_string()
}

async fn inserer_snapshot(pool: &PgPool, user_id: Option<f64>, d: &SaveSnapshotInput) -> Result<i32, sqlx::Error> {
    let label = d
        .label
        .clone()
        .unwrap_or_else(|| format!("{} — {}", if d.type_.as_deref() == Some("export") { "Export" } else { "Snapshot" }, date_fr()));
    // L'identifiant est lié en entier 64 bits : hors bornes de la colonne
    // `integer`, PostgreSQL refuse l'insertion, comme pour la version Node.
    let row = sqlx::query(
        "insert into session_snapshots (user_id, code_fournisseur, nom_fournisseur, magasin, label, changes, summary_json, type) \
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
    )
    .bind(user_id.map(|v| v as i64))
    .bind(&d.code_fournisseur)
    .bind(&d.nom_fournisseur)
    .bind(&d.magasin)
    .bind(label)
    .bind(Value::Object(d.changes.clone()))
    .bind(d.summary.clone())
    .bind(d.type_.clone().unwrap_or_else(|| "snapshot".into()))
    .fetch_one(pool)
    .await?;
    row.try_get("id")
}

/// Enregistre un snapshot pour l'utilisateur. Résultat `{ success, snapshotId?, error? }`.
pub async fn enregistrer_snapshot(user_raw_id: &str, raw: &Value) -> Value {
    let d = match parse_save_snapshot(raw) {
        Ok(d) => d,
        Err(issues) => {
            tracing::error!("Snapshot validation failed: {}", serde_json::to_string(&issues.to_json()).unwrap_or_default());
            return j!({ "success": false, "error": format!("Validation failed: {}", issues.messages_joined()) });
        }
    };
    tracing::info!(
        "[saveSnapshot] User: {} (raw: {user_raw_id}), Supplier: {}, Type: {}",
        user_id_log(user_raw_id),
        d.code_fournisseur,
        d.type_.as_deref().unwrap_or("undefined")
    );
    let final_id = final_user_id(user_raw_id);

    let pool = match db::pool() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Snapshot auto-repair/retry failed: {}", e.message);
            return j!({ "success": false, "error": "erreur technique sur le serveur" });
        }
    };

    match inserer_snapshot(&pool, final_id, &d).await {
        Ok(id) => j!({ "success": true, "snapshotId": id }),
        Err(err) => {
            tracing::error!("Initial snapshot save failed, attempting auto-repair... {err}");
            let reparation = async {
                // Tentative systématique de création de table (no-op si déjà là)
                sqlx::raw_sql(
                    "CREATE TABLE IF NOT EXISTS session_snapshots (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER,
                        code_fournisseur VARCHAR(20) NOT NULL,
                        nom_fournisseur VARCHAR(255),
                        magasin VARCHAR(20) NOT NULL,
                        changes JSONB NOT NULL,
                        summary_json JSONB,
                        label TEXT,
                        type VARCHAR(20) DEFAULT 'snapshot',
                        created_at TIMESTAMP DEFAULT NOW()
                    );",
                )
                .execute(&pool)
                .await?;
                // Si la table existait déjà mais sans la colonne 'type' ou 'user_id', on les ajoute
                let alter = async {
                    sqlx::raw_sql("ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'snapshot'")
                        .execute(&pool)
                        .await?;
                    sqlx::raw_sql("ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS user_id INTEGER").execute(&pool).await
                };
                let _ = alter.await; // Ignore
                                     // Deuxième tentative d'insertion
                inserer_snapshot(&pool, final_id, &d).await
            };
            match reparation.await {
                Ok(id) => j!({ "success": true, "snapshotId": id }),
                Err(e) => {
                    // Le détail technique (les deux erreurs) reste dans les journaux du serveur.
                    tracing::error!("Snapshot auto-repair/retry failed: {e}");
                    j!({ "success": false, "error": "erreur technique sur le serveur" })
                }
            }
        }
    }
}

/// Action `saveSnapshot(raw)`.
async fn save_snapshot(ctx: Ctx) -> AppResult<Value> {
    let utilisateur = match verifier_session(&ctx).await? {
        Ok(u) => u,
        Err(message) => return Ok(j!({ "success": false, "error": message })),
    };
    Ok(enregistrer_snapshot(&utilisateur.id, &ctx.raw(0)).await)
}

pub fn actions() -> Vec<(&'static str, crate::rpc::Handler)> {
    vec![
        ("getSnapshots", crate::handler!(get_snapshots)),
        ("deleteSnapshot", crate::handler!(delete_snapshot)),
        ("saveSnapshot", crate::handler!(save_snapshot)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_comme_zod() {
        let raw: Value = serde_json::from_str(
            r#"{"codeFournisseur":"1","magasin":"T","changes":{"a":{"before":1},"b":3},"type":"x","summary":{"totalRows":"1"}}"#,
        )
        .unwrap();
        let issues = parse_save_snapshot(&raw).unwrap_err();
        assert_eq!(
            serde_json::to_string(&issues.to_json()).unwrap(),
            r#"[{"expected":"string","code":"invalid_type","path":["changes","a","before"],"message":"Invalid input: expected string, received number"},{"expected":"string","code":"invalid_type","path":["changes","a","after"],"message":"Invalid input: expected string, received undefined"},{"expected":"object","code":"invalid_type","path":["changes","b"],"message":"Invalid input: expected object, received number"},{"code":"invalid_value","values":["snapshot","export"],"path":["type"],"message":"Invalid option: expected one of \"snapshot\"|\"export\""},{"expected":"number","code":"invalid_type","path":["summary","totalRows"],"message":"Invalid input: expected number, received string"},{"expected":"number","code":"invalid_type","path":["summary","totalCa"],"message":"Invalid input: expected number, received undefined"},{"expected":"number","code":"invalid_type","path":["summary","totalMarge"],"message":"Invalid input: expected number, received undefined"},{"expected":"number","code":"invalid_type","path":["summary","tauxMargeGlobal"],"message":"Invalid input: expected number, received undefined"}]"#
        );
        let vide = parse_save_snapshot(&j!({})).unwrap_err();
        assert_eq!(
            vide.messages_joined(),
            "Invalid input: expected string, received undefined, Invalid input: expected string, received undefined, Invalid input: expected record, received undefined"
        );
        assert!(parse_save_snapshot(&j!({ "codeFournisseur": "1", "magasin": "T", "changes": [] })).is_err());
    }

    #[test]
    fn donnees_nettoyees() {
        let raw = j!({
            "codeFournisseur": "F1", "magasin": "TOTAL", "inconnu": true,
            "changes": { "200": { "before": null, "after": "A", "x": 1 }, "100": { "before": "B", "after": "Z" } },
            "summary": { "totalRows": 2, "totalCa": 10.5, "totalMarge": 3, "tauxMargeGlobal": 28.5, "y": 0 }
        });
        let d = parse_save_snapshot(&raw).unwrap();
        assert_eq!(serde_json::to_string(&d.changes).unwrap(), r#"{"100":{"before":"B","after":"Z"},"200":{"before":null,"after":"A"}}"#);
        assert_eq!(d.summary.unwrap(), j!({ "totalRows": 2, "totalCa": 10.5, "totalMarge": 3, "tauxMargeGlobal": 28.5 }));
        assert_eq!(d.type_, None);
        assert_eq!(d.label, None);
    }
}
