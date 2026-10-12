//! CollectFlow — Affectation de gammes via l'API `/api/v1`
//! (port de `src/lib/api-gammes.ts`).
//!
//! L'API n'enregistre pas la gamme : elle la **propose**. La proposition est
//! rangée dans `gammes_a_valider` et apparaît dans la Grille comme une
//! modification non enregistrée — on y voit donc quels produits changent de gamme
//! avant de valider (« Enregistrer ») ou de rejeter (« Annuler les modifications »).
//! Tant qu'elle n'est pas validée, `codeGamme` reste inchangée et la proposition
//! est exposée dans `gammeAValider`.
//!
//! Tout ou rien : si un seul article est inconnu chez le fournisseur, rien n'est
//! proposé et la réponse liste les articles en cause.

use super::gammes_a_valider::{proposer_gammes, PropositionGamme};
use super::product_rows::{attendre_persistance, get_product_rows, GetProductRowsInput};
use super::store::{get_grid_freshness, get_grid_rows_gammes};
use crate::api_v1_response::{fail, ApiErrorCode};
use axum::response::Response;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultatGamme {
    pub codein: String,
    /// Gamme proposée.
    pub gamme: String,
    /// Gamme enregistrée au moment de l'appel (modifications validées comprises).
    pub gamme_precedente: Option<String>,
    /// Gamme présente en base FF, non modifiée par l'API.
    pub code_gamme_serveur: Option<String>,
    /// `true` = la gamme change : proposition déposée, à valider dans la Grille.
    /// `false` = l'article a déjà cette gamme (une proposition antérieure en
    /// attente pour lui est retirée).
    pub modifie: bool,
    /// `a_valider` quand `modifie`, sinon `inchangee`.
    pub statut: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectationGammes {
    pub code_fournisseur: String,
    pub nom_fournisseur: Option<String>,
    pub resultats: Vec<ResultatGamme>,
}

/// Lit un corps JSON, ou renvoie une réponse 400 prête à être retournée.
pub fn lire_corps_json(body: &[u8]) -> Result<Value, Response> {
    serde_json::from_slice(body)
        .map_err(|_| fail(ApiErrorCode::BadRequest, "Corps de requête JSON attendu (Content-Type: application/json).", None))
}

/// Propose des gammes pour des articles d'un fournisseur (à valider dans la Grille).
///
/// Si le fournisseur n'a encore jamais été calculé, son instantané est calculé à la
/// demande (`compute`), comme sur `/grid` : sans lui, impossible de vérifier que les
/// articles lui appartiennent.
///
/// `auteur` : nom de la clé d'API ou de l'utilisateur — affiché dans la Grille.
pub async fn affecter_gammes(
    code_fournisseur: &str,
    changes: &[(String, String)],
    compute: bool,
    auteur: &str,
) -> Result<AffectationGammes, Response> {
    // Un même article cité deux fois : la dernière valeur l'emporte (à la place
    // de sa première occurrence, comme une Map JS).
    let mut demandes: Vec<(String, String)> = Vec::new();
    for (codein, gamme) in changes {
        match demandes.iter_mut().find(|(c, _)| c == codein) {
            Some(d) => d.1 = gamme.clone(),
            None => demandes.push((codein.clone(), gamme.clone())),
        }
    }
    let codeins: Vec<String> = demandes.iter().map(|(c, _)| c.clone()).collect();
    let interne = |e: crate::error::AppError| fail(ApiErrorCode::InternalError, e.message, None);

    if compute && get_grid_freshness(code_fournisseur).await.map_err(interne)?.is_none() {
        tracing::info!("[api/v1/gammes] instantané absent pour {code_fournisseur} — calcul à la demande");
        let calcul = get_product_rows(GetProductRowsInput::total(code_fournisseur, false)).await;
        attendre_persistance(code_fournisseur).await;
        if let Err(e) = calcul {
            tracing::error!("[api/v1/gammes] calcul KO pour {code_fournisseur}: {e:#}");
            return Err(fail(
                ApiErrorCode::InternalError,
                format!("Le calcul de la grille a échoué pour le fournisseur « {code_fournisseur} »."),
                None,
            ));
        }
    }

    let actuelles = get_grid_rows_gammes(code_fournisseur, &codeins).await.map_err(interne)?;
    let inconnus: Vec<&String> = codeins.iter().filter(|c| !actuelles.contains_key(*c)).collect();
    if !inconnus.is_empty() {
        return Err(fail(
            ApiErrorCode::NotFound,
            format!(
                "{} article(s) introuvable(s) chez le fournisseur « {code_fournisseur} » : aucune gamme n'a été enregistrée.",
                inconnus.len()
            ),
            Some(json!({ "fournisseur": code_fournisseur, "inconnus": inconnus })),
        ));
    }

    let mut resultats = Vec::with_capacity(demandes.len());
    let mut propositions = Vec::new();
    let mut annules = Vec::new();
    let mut nom_fournisseur: Option<String> = None;

    for (codein, gamme) in demandes {
        let actuelle = &actuelles[&codein];
        if nom_fournisseur.is_none() {
            nom_fournisseur = actuelle.nom_fournisseur.clone();
        }
        let modifie = actuelle.code_gamme.as_deref() != Some(gamme.as_str());
        if modifie {
            propositions.push(PropositionGamme {
                codein: codein.clone(),
                gamme: gamme.clone(),
                gamme_precedente: actuelle.code_gamme.clone(),
            });
        } else {
            annules.push(codein.clone());
        }
        resultats.push(ResultatGamme {
            codein,
            gamme,
            gamme_precedente: actuelle.code_gamme.clone(),
            code_gamme_serveur: actuelle.code_gamme_init.clone(),
            modifie,
            statut: if modifie { "a_valider" } else { "inchangee" },
        });
    }

    if let Err(e) = proposer_gammes(code_fournisseur, &propositions, &annules, auteur).await {
        tracing::error!("[api/v1/gammes] proposition KO pour {code_fournisseur}: {}", e.message);
        return Err(fail(ApiErrorCode::InternalError, "L'enregistrement des gammes à valider a échoué.", None));
    }

    tracing::info!("[api/v1/gammes] {code_fournisseur} — {} gamme(s) à valider proposée(s) par {auteur}", propositions.len());
    Ok(AffectationGammes { code_fournisseur: code_fournisseur.to_string(), nom_fournisseur, resultats })
}
