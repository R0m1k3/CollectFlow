//! Recherche produit **dans Qlik Sense** (source primaire) — port de
//! `src/lib/qlik-search.ts`.
//!
//! La recherche produit part du réseau, pas du catalogue Nancy : on interroge
//! d'abord l'app Qlik « Magasins Vision Consolidée » pour trouver les articles
//! qui correspondent au terme saisi (libellé ou code centrale), puis l'appelant
//! rapproche les codes centraux trouvés de la base FF Nancy.
//!
//! Pourquoi Qlik d'abord : le réseau (~270 magasins) référence beaucoup plus de
//! produits que Nancy. Chercher dans la base locale d'abord masquait tous les
//! produits que le réseau travaille et que nous ne référençons pas — c'est
//! précisément ce qu'on veut voir.
//!
//! Technique : même plomberie que `playwright.rs` (Chromium headless +
//! websocket Engine in-page avec le qlik-csrf-token), car le proxy Qlik refuse
//! un websocket « raw » côté serveur. Le script in-page est `js/recherche.js`.
//!
//! ## Comment la sélection est construite
//!
//! La recherche d'un list object Qlik (`SearchListObjectFor`) applique un **OU**
//! entre les mots : « tapis anti » a ramené 17 696 libellés sur l'app FF, dont
//! l'immense majorité ne contient que « anti ». Sélectionner ces 17 696 valeurs
//! faisait ensuite exploser le cube (`code 15 — Request aborted`).
//!
//! On procède donc en trois temps :
//!   1. une recherche par mot, pour retenir le **plus sélectif** ;
//!   2. lecture de ces valeurs et filtrage **ET** côté client (tous les mots
//!      présents, insensible casse/accents) ;
//!   3. sélection des seules valeurs retenues, **par numéro d'élément**
//!      (`SelectListObjectValues`) — exact, sans ré-appariement de texte.
//!
//! Le résultat final est revérifié une dernière fois avant d'être renvoyé : une
//! liste sans rapport avec la recherche est pire que pas de résultat du tout.

use super::browser::{dans_la_file_qlik, get_qlik_browser, PageQlik};
use super::client::{get_qlik_config, qlik_ntlm_session, QlikConfig};
use super::date_range::{build_grid_network_qlik_date_filter_now, js_number, QLIK_MONTHS_BACK_DEFAULT};
use super::jsnum;
use anyhow::bail;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const SCRIPT_RECHERCHE: &str = include_str!("js/recherche.js");

/// Un article trouvé côté Qlik, **avec ses mesures réseau sur 12 mois glissants**.
///
/// Les mesures sortent du même cube que l'identité : une seule session Qlik pour
/// toute la recherche. Les extraire dans une seconde session concurrente faisait
/// abandonner le moteur (`code 15 — Request aborted`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlikArticleMatch {
    /// Valeur de la dimension « Article Code » — clé de jointure de la Grille.
    pub code_centrale: String,
    /// Champ `article_no_centrale` quand l'app l'expose : second candidat pour la
    /// jointure avec `articles.artcentrale`, les deux ne portant pas toujours le
    /// même format.
    pub code_centrale_alt: String,
    /// Libellé réseau, si l'app expose un champ libellé article.
    pub libelle: String,
    /// Fournisseur réseau, si l'app expose un champ fournisseur.
    pub fournisseur: String,
    /// CA réseau sur la fenêtre 12 mois glissants.
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub ca_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub qte_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub nb_magasins_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub ca_par_magasin_reseau: f64,
    /// Taux de marge réseau, ratio brut Qlik (0.32 = 32 %).
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub marge_pct_reseau: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlikSearchOutcome {
    pub matches: Vec<QlikArticleMatch>,
    /// Champ Qlik effectivement interrogé (diagnostic UI).
    pub champ_utilise: Option<String>,
    /// true si Qlik a renvoyé plus de résultats que la limite demandée.
    pub tronque: bool,
    /// Message de diagnostic quand la recherche aboutit à zéro article alors que
    /// Qlik a bien répondu (filtre non appliqué, terme trop large…). `None` en
    /// fonctionnement nominal.
    pub avertissement: Option<String>,
    /// Fenêtre couverte par les mesures (`YYYY-MM_YYYY-MM`).
    pub periode: Option<String>,
}

/// Nombre maximum d'articles renvoyés par une recherche.
///
/// Chaque code trouvé est ensuite ré-extrait avec son détail mensuel : au-delà
/// de quelques dizaines, la seconde passe devient longue et le résultat
/// illisible. L'utilisateur affine son terme.
pub const QLIK_SEARCH_MAX_RESULTS: usize = 40;

/// Champs candidats pour le libellé article, par ordre de préférence.
///
/// Sur l'app FF, `Article` est le libellé métier et `article_libelle_ticket` le
/// libellé (tronqué) imprimé sur le ticket. On essaie le premier qui donne des
/// résultats : si un candidat ne matche rien, on passe au suivant.
const CHAMPS_LIBELLE_PREFERES: [&str; 2] = ["Article", "article_libelle_ticket"];

/// Champs candidats pour le fournisseur, par ordre de préférence (nom avant code).
const CHAMPS_FOURNISSEUR_PREFERES: [&str; 2] = ["Fournisseur", "code_fournisseur"];

/// Champ portant le code centrale « brut » de l'article, quand il existe.
/// Second candidat de jointure avec `articles.artcentrale` : sur l'app FF, la
/// dimension « Article Code » ne renvoie pas le même format.
const CHAMP_CODE_CENTRALE_ALT: &str = "article_no_centrale";

/// Longueur JS (unités UTF-16).
fn longueur_js(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Cherche dans Qlik les articles correspondant à `term`.
///
/// `limit` : `None` = [`QLIK_SEARCH_MAX_RESULTS`] ; `cfg` : `None` = [`get_qlik_config`].
pub async fn search_qlik_articles(term: &str, limit: Option<usize>, cfg: Option<QlikConfig>) -> anyhow::Result<QlikSearchOutcome> {
    let limit = limit.unwrap_or(QLIK_SEARCH_MAX_RESULTS);
    let cfg = cfg.unwrap_or_else(get_qlik_config);
    // Terme trop court : réponse vide immédiate, sans attendre la file.
    if longueur_js(term.trim()) < 3 {
        return rechercher(term, limit, &cfg).await;
    }
    // Même file que les extractions : deux sessions Engine simultanées font
    // abandonner le serveur Qlik, et les deux requêtes échouent.
    dans_la_file_qlik(&format!("recherche « {} »", term.trim()), || rechercher(term, limit, &cfg)).await
}

async fn rechercher(term: &str, limit: usize, cfg: &QlikConfig) -> anyhow::Result<QlikSearchOutcome> {
    let cleaned = term.trim().to_string();
    if longueur_js(&cleaned) < 3 {
        return Ok(QlikSearchOutcome::default());
    }
    if cfg.app_network.is_empty() {
        bail!("[qlik-search] QLIK_APP_NETWORK manquant");
    }
    if cfg.user.is_empty() || cfg.password.is_empty() {
        bail!("[qlik-search] identifiants Qlik manquants");
    }

    let started = Instant::now();
    // Latence laissée à l'Engine après chaque mutation de sélection. Même réglage
    // que l'extraction (`QLIK_SETTLE_MS`) : sans elle, l'objet créé juste après
    // est calculé sur l'état de sélection précédent.
    let settle = js_number(&std::env::var("QLIK_SETTLE_MS").unwrap_or_else(|_| "250".into()));
    let settle_ms = if settle.is_nan() || settle == 0.0 { 250.0 } else { settle }.clamp(0.0, 2000.0);
    // Même fenêtre que la Grille : 12 mois complets glissants, mois courant exclu.
    let date_filter = build_grid_network_qlik_date_filter_now(QLIK_MONTHS_BACK_DEFAULT);
    let sess = qlik_ntlm_session(cfg).await?;
    let cookie_name = sess.cookie.split('=').next().unwrap_or("").to_string();
    let cookie_value = sess.cookie.splitn(2, '=').nth(1).unwrap_or("").to_string();

    let browser = get_qlik_browser().await?;
    let mut page = PageQlik::ouvrir(
        browser,
        // Le client Qlik est très bavard au chargement (thèmes, extensions) :
        // on ne relaie que ce qui vient de notre script.
        Box::new(|t: &str| t.starts_with("[cf]").then(|| format!("[qlik-search][page] {t}"))),
        None,
    )
    .await?;
    let resultat = async {
        page.identifiants_http(&cfg.user, &cfg.password).await?;
        page.ajouter_cookie(&cookie_name, &cookie_value, &cfg.host).await?;
        let mut jeton_rx = page.capturer_jeton_csrf().await?;
        // Le client Qlik ouvre son ws juste après : une navigation en erreur n'est pas bloquante.
        let _ = page.aller(&format!("https://{}/sense/app/{}", cfg.host, cfg.app_network), Duration::from_millis(cfg.timeout_ms)).await;
        let Some(jeton) = super::playwright::attendre_jeton(&mut jeton_rx).await else {
            bail!("[qlik-search] qlik-csrf-token introuvable (client Qlik non chargé ?)");
        };

        let args = json!({
            "app": cfg.app_network,
            "dim": cfg.dim_code_article_id,
            "token": jeton,
            "terme": cleaned,
            "limite": limit,
            "settleMs": settle_ms,
            "serialsDate": date_filter.daily_serials,
            "mCa": cfg.meas_ca_id,
            "mQte": cfg.meas_qte_id,
            "mNbMag": cfg.meas_nb_mag_id,
            "mCaMag": cfg.meas_ca_mag_id,
            "mMarge": cfg.meas_marge_pct_id,
            "champCodeAlt": CHAMP_CODE_CENTRALE_ALT,
            "champsLibellePreferes": CHAMPS_LIBELLE_PREFERES,
            "champsFournisseurPreferes": CHAMPS_FOURNISSEUR_PREFERES,
            "champLibelleForce": std::env::var("QLIK_FIELD_ARTICLE_LIBELLE").unwrap_or_default().trim(),
            "champFournisseurForce": std::env::var("QLIK_FIELD_FOURNISSEUR").unwrap_or_default().trim(),
        });
        let result = page.evaluer(SCRIPT_RECHERCHE, &args).await?;
        Ok(interpreter(result, &cleaned, started, date_filter.label.clone()))
    }
    .await;
    page.fermer().await;
    resultat?
}

/// Traduit le résultat du script in-page en [`QlikSearchOutcome`].
fn interpreter(result: Value, cleaned: &str, started: Instant, periode: String) -> anyhow::Result<QlikSearchOutcome> {
    for t in result.get("trace").and_then(|t| t.as_array()).into_iter().flatten() {
        tracing::info!("[qlik-search] {}", t.as_str().map(String::from).unwrap_or_else(|| t.to_string()));
    }
    if !result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let err = match result.get("error") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => "undefined".into(),
        };
        bail!("[qlik-search] {err}");
    }

    let chaine = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(autre) => autre.to_string(),
    };
    let nombre = |v: Option<&Value>| v.map(jsnum::nombre).unwrap_or(f64::NAN);
    // [code, codeAlt, libellé, fournisseur, ca, qte, nbMag, caMag, margePct]
    let matches: Vec<QlikArticleMatch> = result
        .get("rows")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_array())
        .map(|l| QlikArticleMatch {
            code_centrale: chaine(l.first()),
            code_centrale_alt: chaine(l.get(1)),
            libelle: chaine(l.get(2)),
            fournisseur: chaine(l.get(3)),
            ca_reseau: nombre(l.get(4)),
            qte_reseau: nombre(l.get(5)),
            nb_magasins_reseau: nombre(l.get(6)),
            ca_par_magasin_reseau: nombre(l.get(7)),
            marge_pct_reseau: nombre(l.get(8)),
        })
        .collect();
    let total = result.get("total").map(jsnum::nombre).unwrap_or(0.0);
    let champ_utilise = result.get("champUtilise").and_then(|c| c.as_str()).map(String::from);
    tracing::info!(
        "[qlik-search] \"{cleaned}\" → {} article(s) (total {}, champ={}) en {} ms",
        matches.len(),
        jsnum::texte(total),
        champ_utilise.as_deref().unwrap_or("null"),
        started.elapsed().as_millis()
    );

    // Zéro article alors que Qlik a répondu : on explique pourquoi plutôt que
    // d'afficher un « aucun résultat » qui laisserait croire à une absence
    // réelle dans le réseau.
    let rejetees = result.get("rejetees").map(jsnum::nombre).unwrap_or(0.0);
    let trop_large = result.get("tropLarge").and_then(|v| v.as_bool()).unwrap_or(false);
    let avertissement = if matches.is_empty() && rejetees > 0.0 {
        Some("Qlik a répondu sans appliquer le filtre de recherche : les articles renvoyés ne correspondaient pas au terme et ont été écartés. Voir les logs [qlik-search].".to_string())
    } else if matches.is_empty() && trop_large {
        Some("Le terme est trop large pour Qlik (plus de 10 000 libellés correspondants). Ajoutez un mot plus précis.".to_string())
    } else {
        None
    };
    if let Some(a) = &avertissement {
        tracing::warn!("[qlik-search] {a}");
    }

    Ok(QlikSearchOutcome { tronque: total > matches.len() as f64, matches, champ_utilise, avertissement, periode: Some(periode) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terme_trop_court() {
        let r = search_qlik_articles("  ab ", None, None).await.unwrap();
        assert!(r.matches.is_empty());
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"matches":[],"champUtilise":null,"tronque":false,"avertissement":null,"periode":null}"#);
    }

    #[test]
    fn interpretation_du_resultat() {
        let v = json!({
            "ok": true, "champUtilise": "Article", "total": 3, "rejetees": 0, "tropLarge": false,
            "rows": [["10000167303", "", "TAPIS BAIN", "F005", 1500.5, 120, 80, 18.75, 0.32]],
            "trace": ["code=Article Code"]
        });
        let r = interpreter(v, "tapis", Instant::now(), "2025-10_2026-09".into()).unwrap();
        assert_eq!(r.matches.len(), 1);
        assert!(r.tronque);
        let j = serde_json::to_string(&r.matches[0]).unwrap();
        assert_eq!(
            j,
            r#"{"codeCentrale":"10000167303","codeCentraleAlt":"","libelle":"TAPIS BAIN","fournisseur":"F005","caReseau":1500.5,"qteReseau":120,"nbMagasinsReseau":80,"caParMagasinReseau":18.75,"margePctReseau":0.32}"#
        );
        let vide = json!({ "ok": true, "rows": [], "rejetees": 4, "total": 0 });
        assert!(interpreter(vide, "x", Instant::now(), String::new()).unwrap().avertissement.unwrap().starts_with("Qlik a répondu sans appliquer"));
        let ko = json!({ "ok": false, "error": "ws error (403 ?)" });
        assert_eq!(interpreter(ko, "x", Instant::now(), String::new()).unwrap_err().to_string(), "[qlik-search] ws error (403 ?)");
    }
}
