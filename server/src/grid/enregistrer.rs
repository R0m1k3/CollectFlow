//! Enregistrement des gammes (port de `src/features/grid/api/enregistrer-gammes.ts`,
//! `save-draft-changes.ts` et `gammes-a-valider-actions.ts`).

use super::gammes_a_valider::{lister_gammes_a_valider, supprimer_gammes_a_valider};
use super::session::{final_user_id, verifier_session};
use super::snapshots::date_fr;
use super::zod::{self, child, Issues, Seg};
use super::{rows_cache, store};
use crate::db;
use crate::error::AppResult;
use crate::rpc::Ctx;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangementGamme {
    pub codein: String,
    /// Gamme avant la modification (état serveur), conservée pour l'historique.
    pub code_gamme_before: Option<String>,
    pub code_gamme: String,
}

#[derive(Debug, Clone, Default)]
pub struct EnregistrementGammes {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub magasin: String,
    pub changes: Vec<ChangementGamme>,
    pub user_id: Option<i64>,
    /// Libellé du snapshot, « Draft — date » par défaut.
    pub label: Option<String>,
}

/// Enregistre des gammes pour un fournisseur — chemin unique de la Grille et de /api/v1.
///
/// Les changements sont fusionnés par-dessus le dernier snapshot du fournisseur,
/// puis reportés dans le cache mémoire de la Grille et dans l'instantané `grid_rows`.
/// Lève une erreur si l'écriture du snapshot échoue.
pub async fn enregistrer_gammes(input: &EnregistrementGammes) -> AppResult<usize> {
    let EnregistrementGammes { code_fournisseur, nom_fournisseur, magasin, changes, user_id, label } = input;
    if changes.is_empty() {
        return Ok(0);
    }
    let pool = db::pool()?;

    // Charger le dernier snapshot existant pour merger les changements
    let existing = sqlx::query("select changes from session_snapshots where code_fournisseur = $1 order by created_at desc limit 1")
        .bind(code_fournisseur)
        .fetch_optional(&pool)
        .await?;
    let prev_changes: Map<String, Value> = match existing.map(|r| r.try_get::<Value, _>("changes")) {
        Some(Ok(Value::Object(m))) => m,
        _ => Map::new(),
    };

    // Merger les nouveaux changements par-dessus l'existant
    let mut merged_changes = prev_changes;
    for c in changes {
        merged_changes.insert(c.codein.clone(), json!({ "before": c.code_gamme_before, "after": c.code_gamme }));
    }

    // Upsert : insérer un nouveau snapshot "draft" pour ce fournisseur
    sqlx::query(
        "insert into session_snapshots (user_id, code_fournisseur, nom_fournisseur, magasin, label, changes, summary_json, type) \
         values ($1, $2, $3, $4, $5, $6, null, 'snapshot')",
    )
    .bind(user_id)
    .bind(code_fournisseur)
    .bind(nom_fournisseur)
    .bind(magasin)
    .bind(label.clone().unwrap_or_else(|| format!("Draft — {}", date_fr())))
    .bind(Value::Object(merged_changes))
    .execute(&pool)
    .await?;

    // Les lignes en cache reçoivent les nouvelles gammes au lieu d'être jetées :
    // l'invalidation imposait un recalcul complet (jusqu'à ~40 s) à la
    // réouverture suivante. L'instantané lu par /api/v1 suit, sans bloquer.
    rows_cache::patch_grid_rows_cache(code_fournisseur, changes.iter().map(|c| (c.codein.as_str(), c.code_gamme.as_str())));
    let code = code_fournisseur.clone();
    let paires: Vec<(String, String)> = changes.iter().map(|c| (c.codein.clone(), c.code_gamme.clone())).collect();
    tokio::spawn(async move {
        if let Err(e) = store::update_grid_rows_gamme(&code, paires.iter().map(|(c, g)| (c.as_str(), g.as_str()))).await {
            tracing::error!("[enregistrerGammes] mise à jour grid_rows KO: {}", crate::error::short(&e.message, 200));
        }
    });

    Ok(changes.len())
}

// ---------------------------------------------------------------------------
// saveDraftChanges
// ---------------------------------------------------------------------------

/// Données validées de `SaveDraftsSchema`.
#[derive(Debug, Clone)]
pub struct SaveDraftsInput {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub magasin: String,
    pub changes: Vec<ChangementGamme>,
    /// Propositions de l'API examinées dans la Grille : validées (présentes dans
    /// `changes`) ou écartées. Elles quittent la file « à valider ».
    pub gammes_a_valider_traitees: Vec<String>,
}

/// `z.array(z.string())`.
fn tableau_de_chaines(v: Option<&Value>, chemin: &[Seg], issues: &mut Issues) -> Option<Vec<String>> {
    let Some(Value::Array(a)) = v else {
        issues.invalid_type(chemin, "array", v);
        return None;
    };
    let mut out = Vec::with_capacity(a.len());
    let mut ok = true;
    for (i, x) in a.iter().enumerate() {
        match zod::string(Some(x), &child(chemin, i), issues) {
            Some(s) => out.push(s),
            None => ok = false,
        }
    }
    ok.then_some(out)
}

/// `SaveDraftsSchema.safeParse(raw)`.
pub fn parse_save_drafts(raw: &Value) -> Result<SaveDraftsInput, Issues> {
    let mut issues = Issues::default();
    let Some(o) = zod::object(Some(raw), &[], &mut issues) else { return Err(issues) };
    let p = |k: &str| vec![Seg::from(k)];

    let code_fournisseur = zod::string(o.get("codeFournisseur"), &p("codeFournisseur"), &mut issues);
    let nom_fournisseur = zod::opt_string(o.get("nomFournisseur"), &p("nomFournisseur"), &mut issues);
    let magasin = zod::string(o.get("magasin"), &p("magasin"), &mut issues);

    let chemin = p("changes");
    let mut changes = Vec::new();
    match o.get("changes") {
        Some(Value::Array(a)) => {
            for (i, x) in a.iter().enumerate() {
                let ci = child(&chemin, i);
                let Some(c) = zod::object(Some(x), &ci, &mut issues) else { continue };
                let codein = zod::string(c.get("codein"), &child(&ci, "codein"), &mut issues);
                let before = zod::nullable_string(c.get("codeGammeBefore"), &child(&ci, "codeGammeBefore"), &mut issues);
                let gamme = zod::string(c.get("codeGamme"), &child(&ci, "codeGamme"), &mut issues);
                if let (Some(codein), Some(code_gamme_before), Some(code_gamme)) = (codein, before, gamme) {
                    changes.push(ChangementGamme { codein, code_gamme_before, code_gamme });
                }
            }
        }
        autre => issues.invalid_type(&chemin, "array", autre),
    }

    let traitees = match o.get("gammesAValiderTraitees") {
        None => Some(Vec::new()),
        v => tableau_de_chaines(v, &p("gammesAValiderTraitees"), &mut issues),
    };

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(SaveDraftsInput {
        code_fournisseur: code_fournisseur.unwrap_or_default(),
        nom_fournisseur: nom_fournisseur.flatten(),
        magasin: magasin.unwrap_or_default(),
        changes,
        gammes_a_valider_traitees: traitees.unwrap_or_default(),
    })
}

/// `saveDraftChanges` une fois la session vérifiée : `{ success, saved, error? }`.
pub async fn enregistrer_brouillon(user_raw_id: &str, raw: &Value) -> Value {
    let d = match parse_save_drafts(raw) {
        Ok(d) => d,
        Err(issues) => return json!({ "success": false, "saved": 0, "error": format!("Validation failed: {}", issues.message()) }),
    };
    let user_id = final_user_id(user_raw_id).map(|v| v as i64);
    let res: AppResult<usize> = async {
        let saved = enregistrer_gammes(&EnregistrementGammes {
            code_fournisseur: d.code_fournisseur.clone(),
            nom_fournisseur: d.nom_fournisseur.clone(),
            magasin: d.magasin.clone(),
            changes: d.changes.clone(),
            user_id,
            label: None,
        })
        .await?;
        supprimer_gammes_a_valider(&d.code_fournisseur, &d.gammes_a_valider_traitees).await?;
        Ok(saved)
    }
    .await;
    match res {
        Ok(saved) => json!({ "success": true, "saved": saved }),
        Err(e) => json!({ "success": false, "saved": 0, "error": e.message }),
    }
}

/// Action `saveDraftChanges(raw)`.
async fn save_draft_changes(ctx: Ctx) -> AppResult<Value> {
    let utilisateur = match verifier_session(&ctx).await? {
        Ok(u) => u,
        Err(message) => return Ok(json!({ "success": false, "saved": 0, "error": message })),
    };
    Ok(enregistrer_brouillon(&utilisateur.id, &ctx.raw(0)).await)
}

// ---------------------------------------------------------------------------
// Gammes à valider (actions)
// ---------------------------------------------------------------------------

/// Action `getGammesAValider(codeFournisseur)` : gammes proposées par l'API pour
/// un fournisseur, en attente de validation.
async fn get_gammes_a_valider(ctx: Ctx) -> AppResult<Value> {
    if let Err(message) = verifier_session(&ctx).await? {
        return Ok(json!({ "success": false, "propositions": [], "error": message }));
    }
    let code = super::js::js_string(ctx.args.first());
    match lister_gammes_a_valider(&code).await {
        Ok(propositions) => Ok(json!({ "success": true, "propositions": propositions })),
        Err(e) => Ok(json!({ "success": false, "propositions": [], "error": e.message })),
    }
}

/// `RejetSchema.safeParse(raw)` → `(codeFournisseur, codeins)`.
pub fn parse_rejet(raw: &Value) -> Result<(String, Vec<String>), Issues> {
    let mut issues = Issues::default();
    let Some(o) = zod::object(Some(raw), &[], &mut issues) else { return Err(issues) };
    let chemin = vec![Seg::from("codeFournisseur")];
    let code = zod::string(o.get("codeFournisseur"), &chemin, &mut issues);
    if let Some(c) = &code {
        zod::check_len(c, &chemin, Some((1, None)), None, &mut issues);
    }
    let codeins = tableau_de_chaines(o.get("codeins"), &[Seg::from("codeins")], &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok((code.unwrap_or_default(), codeins.unwrap_or_default()))
}

/// Action `rejeterGammesAValider(raw)` : rejette des propositions de l'API
/// (« Annuler les modifications » dans la Grille).
async fn rejeter_gammes_a_valider(ctx: Ctx) -> AppResult<Value> {
    if let Err(message) = verifier_session(&ctx).await? {
        return Ok(json!({ "success": false, "error": message }));
    }
    let (code, codeins) = match parse_rejet(&ctx.raw(0)) {
        Ok(v) => v,
        Err(issues) => return Ok(json!({ "success": false, "error": format!("Validation failed: {}", issues.message()) })),
    };
    match supprimer_gammes_a_valider(&code, &codeins).await {
        Ok(()) => Ok(json!({ "success": true })),
        Err(e) => Ok(json!({ "success": false, "error": e.message })),
    }
}

pub fn actions() -> Vec<(&'static str, crate::rpc::Handler)> {
    vec![
        ("saveDraftChanges", crate::handler!(save_draft_changes)),
        ("getGammesAValider", crate::handler!(get_gammes_a_valider)),
        ("rejeterGammesAValider", crate::handler!(rejeter_gammes_a_valider)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_brouillon_comme_zod() {
        let raw = json!({ "codeFournisseur": "1", "magasin": "T", "changes": [{ "codein": "a" }], "gammesAValiderTraitees": "x" });
        let issues = parse_save_drafts(&raw).unwrap_err();
        assert_eq!(
            serde_json::to_string(&issues.to_json()).unwrap(),
            r#"[{"expected":"string","code":"invalid_type","path":["changes",0,"codeGammeBefore"],"message":"Invalid input: expected string, received undefined"},{"expected":"string","code":"invalid_type","path":["changes",0,"codeGamme"],"message":"Invalid input: expected string, received undefined"},{"expected":"array","code":"invalid_type","path":["gammesAValiderTraitees"],"message":"Invalid input: expected array, received string"}]"#
        );
        let ok = parse_save_drafts(
            &json!({ "codeFournisseur": "1", "magasin": "T", "changes": [{ "codein": "a", "codeGammeBefore": null, "codeGamme": "B" }] }),
        )
        .unwrap();
        assert_eq!(ok.changes[0].code_gamme, "B");
        assert!(ok.gammes_a_valider_traitees.is_empty());
    }

    #[test]
    fn validation_rejet_comme_zod() {
        let issues = parse_rejet(&json!({ "codeFournisseur": "", "codeins": [1] })).unwrap_err();
        assert_eq!(
            issues.message(),
            "[\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"inclusive\": true,\n    \"path\": [\n      \"codeFournisseur\"\n    ],\n    \"message\": \"Too small: expected string to have >=1 characters\"\n  },\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"codeins\",\n      0\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"
        );
        assert_eq!(parse_rejet(&json!(5)).unwrap_err().0.len(), 1);
    }
}
