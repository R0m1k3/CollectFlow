//! Extraction Qlik via Chromium headless (port de `src/lib/qlik-playwright.ts`).
//!
//! Le proxy Qlik refuse un websocket "raw" côté serveur (403). On ouvre donc
//! l'app dans Chromium avec une session authentifiée (cookie X-Qlik-Session
//! injecté via le flux ticket NTLM), on récupère le **qlik-csrf-token** que le
//! client Qlik utilise pour SON websocket, puis on ouvre notre propre websocket
//! Engine **in-page** avec ce token (le proxy l'accepte).
//!
//! Toute la logique Engine (sélections, cubes, passes mensuelles, retries
//! code 15, sélection par fournisseur, contrôles de fenêtre…) vit dans le
//! script in-page `js/extraction.js`, copie conforme du TS. Ce fichier-ci garde
//! la partie serveur : réglages d'environnement, session, reprises globales,
//! agrégation finale et contrôles de plausibilité avant écriture.

use super::browser::{dans_la_file_qlik, get_qlik_browser, PageQlik};
use super::client::{get_qlik_config, qlik_ntlm_session, NetworkMetric, QlikConfig, QlikMonthMetrics};
use super::date_range::{get_month_ranges, js_number, qlik_serial_to_ymd, QlikDateFilter};
use super::jsnum;
use super::validation::{assainir_metrique, controler_extraction, OptionsControle};
use anyhow::{anyhow, bail};
use chrono::Datelike;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Script exécuté dans la page (fonction de `page.evaluate` du TS).
const SCRIPT_EXTRACTION: &str = include_str!("js/extraction.js");

/// Résultat du script in-page.
#[derive(Debug, Default, Clone)]
struct InPageResult {
    ok: bool,
    rows: Vec<Vec<Value>>,
    /// Métriques réseau par code central et par mois : { code: { "YYYY-MM": {…} } }.
    monthly: BTreeMap<String, BTreeMap<String, QlikMonthMetrics>>,
    size: Option<f64>,
    error: Option<String>,
    // Compteurs agrégés pour le résumé timing final.
    months: Option<f64>,
    batches: Option<f64>,
    code15_retries: Option<f64>,
    fallback_count: Option<f64>,
    /// true si le résultat vient d'un point de contrôle (extraction interrompue).
    partiel: bool,
    /// Diagnostics clés du chemin par expressions, répétés en fin de sync.
    diag_expr: Vec<String>,
}

fn lire_monthly(v: Option<&Value>) -> BTreeMap<String, BTreeMap<String, QlikMonthMetrics>> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(par_code)) = v {
        for (code, par_mois) in par_code {
            let mut mois_map = BTreeMap::new();
            if let Value::Object(pm) = par_mois {
                for (mois, m) in pm {
                    if let Ok(mm) = serde_json::from_value::<QlikMonthMetrics>(m.clone()) {
                        mois_map.insert(mois.clone(), mm);
                    }
                }
            }
            out.insert(code.clone(), mois_map);
        }
    }
    out
}

fn lire_rows(v: Option<&Value>) -> Vec<Vec<Value>> {
    v.and_then(|r| r.as_array()).map(|a| a.iter().map(|l| l.as_array().cloned().unwrap_or_default()).collect()).unwrap_or_default()
}

impl InPageResult {
    fn depuis(v: &Value) -> Self {
        let nombre = |k: &str| v.get(k).filter(|x| !x.is_null()).map(jsnum::nombre);
        Self {
            ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
            rows: lire_rows(v.get("rows")),
            monthly: lire_monthly(v.get("monthly")),
            size: nombre("size"),
            error: v.get("error").map(|e| match e {
                Value::String(s) => s.clone(),
                autre => autre.to_string(),
            }),
            months: nombre("months"),
            batches: nombre("batches"),
            code15_retries: nombre("code15Retries"),
            fallback_count: nombre("fallbackCount"),
            partiel: v.get("partiel").and_then(|x| x.as_bool()).unwrap_or(false),
            diag_expr: v
                .get("diagExpr")
                .and_then(|d| d.as_array())
                .map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect())
                .unwrap_or_default(),
        }
    }
}

/// `envNumber` : entier borné, défaut si absent / vide / non numérique.
fn env_number(name: &str, default: i64, min: i64, max: i64) -> i64 {
    crate::config::env_number(name, default, min, max)
}

/// `envNumberCsv` : liste d'entiers bornés (`Number("")` = 0, comme en JS).
fn env_number_csv(name: &str, min: i64, max: i64) -> Vec<i64> {
    let Some(raw) = std::env::var(name).ok().filter(|v| !v.is_empty()) else { return Vec::new() };
    raw.split(',').map(|part| js_number(part.trim())).filter(|v| v.is_finite()).map(|v| (v.trunc() as i64).clamp(min, max)).collect()
}

fn unique_ordered(values: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    values.iter().copied().filter(|v| seen.insert(*v)).collect()
}

/// Option booléenne activée par défaut, coupée par `0` / `false` / `no` / `off`.
fn env_actif(name: &str) -> bool {
    let v = std::env::var(name).unwrap_or_default().trim().to_lowercase();
    !["0", "false", "no", "off"].contains(&v.as_str())
}

fn env_trim(name: &str, defaut: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| defaut.to_string()).trim().to_string()
}

/// `String(x)` sur une cellule JSON.
fn texte_js(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => jsnum::texte(n.as_f64().unwrap_or(f64::NAN)),
        Value::Null => "null".into(),
        autre => autre.to_string(),
    }
}

/// Extraction des métriques réseau (CA, quantités, magasins, marge et détail
/// mensuel) des codes centraux demandés.
///
/// - `codes` : codes centraux (`None` = tous ceux que renvoie le cube).
/// - `cfg` : `None` = [`get_qlik_config`].
/// - `date_filter` : fenêtre à extraire ; `None` = mode sans date (le `null` du TS).
///   Les appelants passent toujours une fenêtre (12 mois glissants).
/// - `fournisseur` : code fournisseur FF (ex. `J009`). Quand il est fourni, on
///   sélectionne LE fournisseur côté Qlik au lieu des dizaines de milliers de
///   codes articles : `SelectValues` sur « Article Code » coûte 8 à 100 s par
///   appel quel que soit le nombre de valeurs (le moteur balaie un symbole de
///   plus d'un million d'entrées), et il faut le refaire à chaque passe annuelle.
///   La bascule n'est retenue que si la sélection fournisseur **couvre** les
///   codes demandés — sinon on revient à la sélection par codes.
///
/// Passe par la file Qlik unique : une seule session Engine à la fois.
pub async fn fetch_network_metrics_playwright(
    codes: Option<Vec<String>>,
    cfg: Option<QlikConfig>,
    date_filter: Option<QlikDateFilter>,
    fournisseur: Option<String>,
) -> anyhow::Result<IndexMap<String, NetworkMetric>> {
    let libelle = match &fournisseur {
        Some(f) if !f.is_empty() => format!("fournisseur {f}"),
        _ => format!("{} code(s)", codes.as_ref().map(|c| c.len()).unwrap_or(0)),
    };
    let cfg = cfg.unwrap_or_else(get_qlik_config);
    dans_la_file_qlik(&libelle, || extraire(codes, cfg, date_filter, fournisseur)).await
}

async fn extraire(
    codes: Option<Vec<String>>,
    cfg: QlikConfig,
    date_filter: Option<QlikDateFilter>,
    fournisseur: Option<String>,
) -> anyhow::Result<IndexMap<String, NetworkMetric>> {
    if cfg.app_network.is_empty() {
        bail!("[qlik-pw] QLIK_APP_NETWORK manquant");
    }
    if cfg.user.is_empty() || cfg.password.is_empty() {
        bail!("[qlik-pw] identifiants Qlik manquants");
    }

    // Démarre l'horloge pour le résumé timing final (cf. bloc [qlik-pw][summary]).
    let total_start = Instant::now();
    let nb_codes = codes.as_ref().map(|c| c.len()).unwrap_or(0);
    tracing::info!("[qlik-pw] host={} app={} — {nb_codes} codes à sélectionner", cfg.host, cfg.app_network);
    if let Some(df) = &date_filter {
        tracing::info!("[qlik-pw] filtre Date={} ({} → {}, {})", df.label, df.date_debut, df.date_fin, df.set_analysis);
    }
    let sess = qlik_ntlm_session(&cfg).await?;
    let cookie_name = sess.cookie.split('=').next().unwrap_or("").to_string();
    tracing::info!("[qlik-pw] session NTLM OK, cookie={cookie_name}=…");
    let cookie_value = sess.cookie.splitn(2, '=').nth(1).unwrap_or("").to_string();
    let qlik_settle_ms = env_number("QLIK_SETTLE_MS", 150, 0, 2000);
    let qlik_code15_max_attempts = env_number("QLIK_CODE15_MAX_ATTEMPTS", 4, 1, 8);
    let qlik_article_batch_size = env_number("QLIK_ARTICLE_BATCH_SIZE", 150, 1, 500);
    let csv_fallbacks = env_number_csv("QLIK_ARTICLE_BATCH_FALLBACKS", 1, 500);
    let mut tailles = vec![qlik_article_batch_size];
    tailles.extend(if csv_fallbacks.is_empty() { vec![75, 50] } else { csv_fallbacks });
    tailles.extend([75, 50]);
    let qlik_article_batch_fallbacks = unique_ordered(&tailles);
    // Chemin rapide : sélectionner TOUS les Article Code une seule fois, puis ne
    // changer que la Date par mois (au lieu de re-sélectionner par lots de 150 chaque
    // mois). Repli automatique sur le chemin par lots en cas de code 15.
    // ACTIVÉ PAR DÉFAUT (validé fiable) — désactivable seulement avec QLIK_SELECT_ALL_CODES=0.
    let qlik_select_all_codes = env_actif("QLIK_SELECT_ALL_CODES");
    // Découpage mensuel réel via la dimension "Mois" (cube [Article Code, Mois]) : donne
    // les vraies quantités par mois ET le vrai total (au lieu de 12× la valeur annuelle).
    // Désactiver (QLIK_MONTH_DIM=0) fait désormais échouer la sync datée.
    let qlik_month_dim = env_actif("QLIK_MONTH_DIM");
    let qlik_mois_dim_id = env_trim("QLIK_MOIS_DIM_ID", "pfGAwTs");
    // Mesure "Quantité COMP" (année N-1) pour compléter les mois de l'année précédente.
    let qlik_meas_qte_comp_id = env_trim("QLIK_MEAS_QTE_COMP_ID", "96862880-76cd-4957-bf25-b96901f2ac5f");
    // Agrégations directes des champs de faits. Les master measures « N » ignorent
    // la sélection Date (mesures « cumul année en cours ») : elles ne peuvent pas
    // produire une fenêtre 12 mois glissants. Surchargeables si le modèle change.
    let qlik_use_expr = env_actif("QLIK_USE_EXPR");
    let qlik_expr_qte = env_trim("QLIK_EXPR_QTE", "Sum(quantite)");
    let qlik_expr_ca = env_trim("QLIK_EXPR_CA", "Sum(ca_ht)");
    let qlik_expr_nb_mag = env_trim("QLIK_EXPR_NBMAG", "Count(DISTINCT [Magasin Code])");
    let qlik_expr_marge = env_trim("QLIK_EXPR_MARGE", "Sum(marge)");
    // Champs Qlik susceptibles de porter le CODE fournisseur (et non son libellé) :
    // c'est `code_fournisseur` qui remontait des valeurs de la forme « F005 »,
    // « A0491 » — même format que les codes de la base FF.
    let mut qlik_supplier_fields: Vec<String> = Vec::new();
    for c in [env_trim("QLIK_FIELD_CODE_FOURNISSEUR", ""), "code_fournisseur".into(), "Fournisseur".into(), "fournisseur_code_centrale".into()] {
        if !c.is_empty() && !qlik_supplier_fields.contains(&c) {
            qlik_supplier_fields.push(c);
        }
    }
    // Part des codes demandés que la sélection fournisseur doit couvrir pour être retenue.
    let couverture = js_number(&std::env::var("QLIK_SUPPLIER_MIN_COVERAGE").unwrap_or_else(|_| "0.99".into()));
    let couverture = if couverture.is_nan() || couverture == 0.0 { 0.99 } else { couverture };
    let qlik_supplier_min_coverage = couverture.clamp(0.5, 1.0);

    // Champs date candidats, essayés dans l'ordre. Un champ n'est retenu que s'il
    // FILTRE réellement les faits (total non nul et strictement inférieur au total
    // sans filtre).
    let mut qlik_date_fields: Vec<String> = Vec::new();
    for c in [env_trim("QLIK_DATE_FIELD", ""), "Date".into(), "Date calendrier".into(), "Date_Key".into()] {
        if !c.is_empty() && !qlik_date_fields.contains(&c) {
            qlik_date_fields.push(c);
        }
    }
    let year_n = chrono::Local::now().year();
    tracing::info!(
        "[qlik-pw] tuning settle={qlik_settle_ms}ms code15Attempts={qlik_code15_max_attempts} batchFallbacks={} selectAllCodes={qlik_select_all_codes} monthDim={qlik_month_dim} useExpr={qlik_use_expr}",
        qlik_article_batch_fallbacks.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(">")
    );
    if qlik_use_expr {
        tracing::info!("[qlik-pw] expressions mensuelles: qte=\"{qlik_expr_qte}\" ca=\"{qlik_expr_ca}\" nbMag=\"{qlik_expr_nb_mag}\" marge=\"{qlik_expr_marge}\"");
        tracing::info!("[qlik-pw] champs date candidats: {}", serde_json::to_string(&qlik_date_fields)?);
    }

    let browser = get_qlik_browser().await?;
    tracing::info!("[qlik-pw] chromium lancé");
    let mut page = PageQlik::ouvrir(browser, Box::new(|t: &str| Some(format!("[qlik-pw][page] {t}"))), Some("[qlik-pw][pageerror]")).await?;
    let resultat = async {
        page.identifiants_http(&cfg.user, &cfg.password).await?;
        page.ajouter_cookie(&cookie_name, &cookie_value, &cfg.host).await?;
        extraire_dans_la_page(
            &mut page,
            &cfg,
            codes,
            date_filter,
            fournisseur,
            total_start,
            json!({
                "qlikSettleMs": qlik_settle_ms,
                "qlikCode15MaxAttempts": qlik_code15_max_attempts,
                "qlikArticleBatchFallbacks": qlik_article_batch_fallbacks,
                "selectAllCodes": qlik_select_all_codes,
                "monthDim": qlik_month_dim,
                "moisDimId": qlik_mois_dim_id,
                "mqteComp": qlik_meas_qte_comp_id,
                "yearN": year_n,
                "useExpr": qlik_use_expr,
                "exprQte": qlik_expr_qte,
                "exprCa": qlik_expr_ca,
                "exprNbMag": qlik_expr_nb_mag,
                "exprMarge": qlik_expr_marge,
                "champsDateCandidats": qlik_date_fields,
                "champsFournisseurCandidats": qlik_supplier_fields,
                "couvertureFournisseurMin": qlik_supplier_min_coverage,
            }),
        )
        .await
    }
    .await;
    page.fermer().await;
    resultat
}

/// Jeton CSRF du client Qlik : attendu au plus 15 s après le chargement.
pub(super) async fn attendre_jeton(rx: &mut tokio::sync::watch::Receiver<Option<String>>) -> Option<String> {
    let _ = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|j| j.is_some())).await;
    let jeton = rx.borrow().clone();
    jeton
}

async fn extraire_dans_la_page(
    page: &mut PageQlik,
    cfg: &QlikConfig,
    codes: Option<Vec<String>>,
    date_filter: Option<QlikDateFilter>,
    fournisseur: Option<String>,
    total_start: Instant,
    reglages: Value,
) -> anyhow::Result<IndexMap<String, NetworkMetric>> {
    // Capture le qlik-csrf-token depuis le websocket que le client Qlik ouvre.
    let mut jeton_rx = page.capturer_jeton_csrf().await?;
    // Le client ouvre son ws ensuite : une navigation lente ou en erreur n'est pas bloquante.
    let _ = page.aller(&format!("https://{}/sense/app/{}", cfg.host, cfg.app_network), Duration::from_millis(cfg.timeout_ms)).await;
    tracing::info!("[qlik-pw] page chargée, attente du qlik-csrf-token…");
    let Some(jeton) = attendre_jeton(&mut jeton_rx).await else {
        bail!("[qlik-pw] qlik-csrf-token introuvable (client Qlik non chargé ?)");
    };
    tracing::info!("[qlik-pw] csrf-token capturé, ouverture du websocket Engine in-page…");

    // Pré-calcul des mois côté serveur (pour pouvoir logger X/Y et propager au script in-page).
    let month_ranges: Vec<QlikDateFilter> = date_filter.as_ref().map(get_month_ranges).unwrap_or_default();
    let monthly_payload: Vec<Value> = month_ranges
        .iter()
        .map(|m| {
            json!({
                "label": m.label,
                "dateDebut": m.date_debut,
                "dateFin": m.date_fin,
                "serials": m.daily_serials, // ~30 valeurs → SelectValues en une fois
                // Même fenêtre au format entier AAAAMMJJ : certains modèles Qlik
                // n'exposent la date que par une clé numérique (`Date_Key`), pas par
                // un champ date sérialisé.
                "ymd": m.daily_serials.iter().map(|s| qlik_serial_to_ymd(*s)).collect::<Vec<_>>(),
            })
        })
        .collect();

    // Point de contrôle : le script in-page pousse ses résultats intermédiaires
    // à chaque passe. Si la session Qlik meurt en cours de route (« Socket
    // closed », « Execution context was destroyed »), on repart de là au lieu
    // de tout perdre — les codes déjà traités ont des données complètes, la
    // dimension Mois livrant tous leurs mois d'un coup.
    let checkpoint: Arc<parking_lot::Mutex<Option<Value>>> = Arc::new(parking_lot::Mutex::new(None));
    let mut appels = page.exposer_fonction("cfCheckpoint").await?;
    let cible = checkpoint.clone();
    let recepteur = tokio::spawn(async move {
        while let Some(payload) = appels.recv().await {
            if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                *cible.lock() = Some(v);
            }
        }
    });

    let mut args = Map::new();
    args.insert("app".into(), json!(cfg.app_network));
    args.insert("dim".into(), json!(cfg.dim_code_article_id));
    args.insert("mca".into(), json!(cfg.meas_ca_id));
    args.insert("mqte".into(), json!(cfg.meas_qte_id));
    args.insert("mnb".into(), json!(cfg.meas_nb_mag_id));
    args.insert("mcamag".into(), json!(cfg.meas_ca_mag_id));
    args.insert("mmarge".into(), json!(cfg.meas_marge_pct_id));
    args.insert("codes".into(), json!(codes.clone().unwrap_or_default()));
    args.insert("token".into(), json!(jeton));
    args.insert("monthlyPayload".into(), Value::Array(monthly_payload));
    args.insert("noDateMode".into(), json!(date_filter.is_none()));
    args.insert("fournisseurCode".into(), json!(fournisseur.as_deref().unwrap_or("").trim()));
    if let Value::Object(r) = reglages {
        args.extend(r);
    }
    let args = Value::Object(args);

    // Reprise globale sur erreur transitoire.
    //
    // Le moteur Qlik abandonne les requêtes longues quand il est chargé
    // (« code 15 / Request aborted »). Observé sur un même fournisseur, avec
    // le même code : réussite à 4 h du matin (OpenDoc en 78 s), échec à 6 h
    // (OpenDoc en 233 s, puis abandon). Les reprises par requête de
    // `rpcWithRetry` ne suffisent pas — c'est toute l'extraction qui tombe.
    //
    // La pause est volontairement longue : relancer aussitôt ne ferait
    // qu'ajouter de la charge au serveur qui vient déjà de renoncer.
    let extraction_essais = 1 + env_number("QLIK_EXTRACTION_RETRIES", 1, 0, 3);
    let extraction_pause_ms = env_number("QLIK_EXTRACTION_RETRY_PAUSE_MS", 60_000, 0, 600_000) as u64;
    let re15 = regex::Regex::new(r#""code"\s*:\s*15\b"#).expect("regex");
    let re_abort = regex::Regex::new(r"(?i)request aborted").expect("regex");
    let est_transitoire = |m: &str| re15.is_match(m) || re_abort.is_match(m);
    let tronque = |s: &str, n: usize| s.chars().take(n).collect::<String>();

    let mut essai = 0;
    let mut result = loop {
        essai += 1;
        let reste = essai < extraction_essais;
        match page.evaluer(SCRIPT_EXTRACTION, &args).await {
            Ok(v) => {
                let candidat = InPageResult::depuis(&v);
                let err = candidat.error.clone().unwrap_or_else(|| "undefined".into());
                if candidat.ok || !reste || !est_transitoire(&err) {
                    break candidat;
                }
                tracing::warn!(
                    "[qlik-pw] tentative {essai}/{extraction_essais} abandonnée par le moteur ({}) — nouvelle tentative dans {} s",
                    tronque(&err, 160),
                    (extraction_pause_ms as f64 / 1000.0).round()
                );
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if reste && est_transitoire(&msg) {
                    tracing::warn!(
                        "[qlik-pw] tentative {essai}/{extraction_essais} interrompue ({}) — nouvelle tentative dans {} s",
                        tronque(&msg, 160),
                        (extraction_pause_ms as f64 / 1000.0).round()
                    );
                } else {
                    recepteur.abort();
                    // Comportement d'origine, une fois les reprises épuisées.
                    // Une fenêtre 12 mois n'est publiable que si l'extraction est
                    // complète et a passé tous les contrôles. Conserver un checkpoint
                    // partiel fabriquerait précisément des graphiques à 2 ou 3 mois.
                    if date_filter.is_some() {
                        bail!("[qlik-pw] extraction 12 mois interrompue, cache inchangé : {msg}");
                    }
                    let secours = checkpoint.lock().take();
                    let rows = lire_rows(secours.as_ref().and_then(|s| s.get("rows")));
                    if !rows.is_empty() {
                        tracing::error!(
                            "[qlik-pw] extraction interrompue ({}) — reprise du dernier point de contrôle : {} lignes",
                            tronque(&msg, 200),
                            rows.len()
                        );
                        let n = rows.len() as f64;
                        break InPageResult {
                            ok: true,
                            monthly: lire_monthly(secours.as_ref().and_then(|s| s.get("monthly"))),
                            rows,
                            size: Some(n),
                            partiel: true,
                            ..Default::default()
                        };
                    }
                    return Err(e);
                }
            }
        }
        *checkpoint.lock() = None; // la nouvelle tentative repart d'une extraction vierge
        tokio::time::sleep(Duration::from_millis(extraction_pause_ms)).await;
    };
    recepteur.abort();

    if !result.ok {
        let err = result.error.clone().unwrap_or_else(|| "undefined".into());
        if date_filter.is_some() {
            bail!("[qlik-pw] extraction 12 mois refusée, cache inchangé : {err}");
        }
        // Même logique qu'un crash : un résultat partiel vaut mieux que rien.
        if !result.rows.is_empty() {
            tracing::error!("[qlik-pw] extraction en échec ({}) — {} lignes déjà extraites conservées", tronque(&err, 200), result.rows.len());
            result.ok = true;
            result.partiel = true;
        } else {
            bail!("[qlik-pw] {err}");
        }
    }
    if result.partiel {
        if date_filter.is_some() {
            bail!("[qlik-pw] extraction 12 mois partielle refusée, cache inchangé");
        }
        tracing::warn!("[qlik-pw] ⚠ résultat PARTIEL : certains codes n'ont pas été extraits, relancer la sync pour compléter");
    }

    // Résumé timing final : synthèse compacte de la sync pour audit/debug.
    // Les logs détaillés par étape restent en place (timings batch/mois) ;
    // ici on consolide les compteurs agrégés et la durée totale.
    let total_ms = total_start.elapsed().as_millis();
    if !result.diag_expr.is_empty() {
        tracing::info!("[qlik-pw][diag] ─── diagnostic du chemin par expressions ───");
        for d in &result.diag_expr {
            tracing::info!("[qlik-pw][diag] {d}");
        }
    }
    let n = |v: Option<f64>| jsnum::texte(v.unwrap_or(0.0));
    tracing::info!(
        "[qlik-pw][summary] rows={} months={} batches={} code15Retries={} fallbackCount={} totalMs={total_ms}",
        n(result.size),
        n(result.months),
        n(result.batches),
        n(result.code15_retries),
        n(result.fallback_count)
    );

    let wanted: Option<HashSet<&str>> = codes.as_ref().map(|c| c.iter().map(|s| s.as_str()).collect());
    let mut out: IndexMap<String, NetworkMetric> = IndexMap::new();
    let mut marge_weight: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for r in &result.rows {
        let code = r.first().map(texte_js).unwrap_or_else(|| "undefined".into()).trim().to_string();
        if code.is_empty() || code == "-" {
            continue;
        }
        if let Some(w) = &wanted {
            if !w.contains(code.as_str()) {
                continue;
            }
        }
        let col = |i: usize| jsnum::nombre_ou_0(r.get(i));
        let (ca, qte, nb_mag, marge_pct) = (col(1), col(2), col(3), col(5));
        let Some(prev) = out.get_mut(&code) else {
            out.insert(
                code.clone(),
                NetworkMetric {
                    code_centrale: code.clone(),
                    ca_reseau: ca,
                    qte_reseau: qte,
                    nb_magasins_reseau: nb_mag,
                    ca_par_magasin_reseau: if nb_mag > 0.0 { ca / nb_mag } else { 0.0 },
                    marge_pct_reseau: marge_pct,
                    periode: date_filter.as_ref().map(|d| d.label.clone()),
                    ..Default::default()
                },
            );
            marge_weight.insert(code, ca);
            continue;
        };
        prev.ca_reseau += ca;
        prev.qte_reseau += qte;
        prev.nb_magasins_reseau = prev.nb_magasins_reseau.max(nb_mag);
        let weight = marge_weight.get(&code).copied().unwrap_or(0.0);
        let next_weight = weight + ca;
        prev.marge_pct_reseau =
            if next_weight > 0.0 { (prev.marge_pct_reseau * weight + marge_pct * ca) / next_weight } else { prev.marge_pct_reseau.max(marge_pct) };
        prev.ca_par_magasin_reseau = if prev.nb_magasins_reseau > 0.0 { prev.ca_reseau / prev.nb_magasins_reseau } else { 0.0 };
        marge_weight.insert(code, next_weight);
    }

    // Rattache le détail mensuel (par code central) au métrique agrégé.
    // On produit DEUX représentations :
    //   - `qteByMonth`  : { "YYYY-MM": qté } — format historique, dont dépend la
    //                     colonne « Tendance / Réseau » de la Grille. Inchangé.
    //   - `metricsByMonth` : toutes les mesures du mois, pour la fiche produit.
    //
    // Mois RÉELLEMENT couverts par l'extraction = union des mois vus sur
    // l'ensemble des codes. Distinguer « couvert, zéro vente » de « non
    // extrait » est indispensable : sans cela, un article vendu seulement
    // depuis mai voyait sa tendance calculée sur deux points (« +4 100 % »),
    // et un mois non extrait passait pour une absence de vente.
    let mois_couverts: Vec<String> = result.monthly.values().flat_map(|pm| pm.keys().cloned()).collect::<BTreeSet<_>>().into_iter().collect();
    tracing::info!("[qlik-pw] mois couverts par l'extraction ({}) : {}", mois_couverts.len(), serde_json::to_string(&mois_couverts)?);

    let vide = BTreeMap::new();
    for (code, metric) in out.iter_mut() {
        let mm = result.monthly.get(code).unwrap_or(&vide);
        let mut qte_by_month = BTreeMap::new();
        let mut metrics_by_month = BTreeMap::new();
        for mois in &mois_couverts {
            let v = mm.get(mois);
            // Zéro EXPLICITE sur un mois couvert sans vente : c'est une
            // information, au même titre qu'une vente. Un mois non couvert
            // reste absent et sera ignoré par la tendance.
            let q = v.map(|x| x.qte).unwrap_or(0.0);
            qte_by_month.insert(mois.clone(), if q.is_nan() { 0.0 } else { q });
            // ⚠️ Toutes les mesures à zéro, pas seulement la quantité. Écrire
            // `{ qte: 0 }` seul laissait `nbMag` absent sur les mois sans
            // vente : la courbe « magasins vendeurs » exigeant les 12 mois,
            // elle disparaissait dès qu'un produit avait un mois creux.
            metrics_by_month.insert(
                mois.clone(),
                v.cloned().unwrap_or(QlikMonthMetrics { qte: 0.0, ca: Some(0.0), nb_mag: Some(0.0), ca_mag: Some(0.0), marge_pct: Some(0.0) }),
            );
        }
        metric.qte_by_month = Some(qte_by_month);
        metric.metrics_by_month = Some(metrics_by_month);
    }

    // Diagnostic CONCLUSIF : combien de codes ont des mois qui VARIENT vs identiques.
    // Si presque tous varient → la mesure respecte le mois (feature OK).
    // Si tous identiques → la mesure Qlik ignore la sélection Date.
    let (mut n_var, mut n_flat) = (0, 0);
    let (mut ex_var, mut ex_flat): (Option<&NetworkMetric>, Option<&NetworkMetric>) = (None, None);
    for m in out.values() {
        let Some(bm) = &m.qte_by_month else { continue };
        let vals: Vec<f64> = bm.values().copied().collect();
        if vals.len() < 2 {
            continue;
        }
        if vals.iter().all(|v| *v == vals[0]) {
            n_flat += 1;
            ex_flat.get_or_insert(m);
        } else {
            n_var += 1;
            ex_var.get_or_insert(m);
        }
    }
    let qbm = |m: &NetworkMetric| {
        let v: Map<String, Value> = m.qte_by_month.iter().flatten().map(|(k, x)| (k.clone(), jsnum::valeur(*x))).collect();
        Value::Object(v).to_string()
    };
    tracing::info!("[qlik-pw] qteByMonth distribution: {n_var} codes VARIENT / {n_flat} identiques (total {})", n_var + n_flat);
    if let Some(m) = ex_var {
        tracing::info!("[qlik-pw] exemple VARIE {}: {}", m.code_centrale, qbm(m));
    }
    if let Some(m) = ex_flat {
        tracing::info!("[qlik-pw] exemple IDENTIQUE {}: {}", m.code_centrale, qbm(m));
    }
    tracing::info!("[qlik-pw] {} produits réseau (cube {})", out.len(), n(result.size));

    // Contrôle de plausibilité AVANT toute écriture : des données complètes
    // mais fausses (dernier mois pas encore chargé, mesure insensible au
    // mois) laisseraient le cache faux jusqu'à la synchro suivante.
    let corrections: Vec<String> = out.values_mut().flat_map(assainir_metrique).collect();
    if !corrections.is_empty() {
        tracing::warn!(
            "[qlik-pw] {} valeur(s) impossible(s) corrigée(s) : {}",
            corrections.len(),
            corrections.iter().take(5).cloned().collect::<Vec<_>>().join(" ; ")
        );
    }
    if date_filter.is_some() {
        let fenetre: Vec<String> = month_ranges.iter().map(|m| m.label.clone()).collect();
        let controle = controler_extraction(out.values(), &fenetre, chrono::Local::now().date_naive(), OptionsControle::default());
        for a in &controle.avertissements {
            tracing::warn!("[qlik-pw][contrôle] {a}");
        }
        if !controle.ok {
            return Err(anyhow!("[qlik-pw] {} — cache inchangé", controle.motif.unwrap_or_default()));
        }
        tracing::info!("[qlik-pw][contrôle] extraction validée ({} codes, {} mois)", out.len(), month_ranges.len());
    }
    // Échantillon brut pour vérifier que les mesures (cols 1-5) renvoient des valeurs
    let sample: Vec<Value> = result
        .rows
        .iter()
        .take(3)
        .map(|r| {
            let c = |i: usize| r.get(i).cloned().unwrap_or(Value::Null);
            json!({ "code": c(0), "ca": c(1), "qte": c(2), "nbMag": c(3), "caMag": c(4), "margePct": c(5) })
        })
        .collect();
    let echantillon = Value::Array(sample).to_string();
    tracing::info!("[qlik-pw] échantillon lignes: {echantillon}");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailles_de_lots() {
        assert_eq!(unique_ordered(&[150, 75, 50, 75, 50]), vec![150, 75, 50]);
        assert_eq!(unique_ordered(&[100, 100, 25, 75, 50]), vec![100, 25, 75, 50]);
    }

    #[test]
    fn resultat_in_page() {
        let v = json!({
            "ok": true,
            "rows": [["C1", 10.5, 3, 2, 5.25, 0.3], ["C1", 1, 1, 4, null, 0.1]],
            "monthly": { "C1": { "2026-01": { "qte": 3, "ca": 10.5 }, "2026-02": { "qte": null } } },
            "size": 2, "months": 12, "diagExpr": ["a", "b"]
        });
        let r = InPageResult::depuis(&v);
        assert!(r.ok);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.monthly["C1"]["2026-01"].ca, Some(10.5));
        assert!(r.monthly["C1"]["2026-02"].qte.is_nan());
        assert_eq!(r.diag_expr, vec!["a", "b"]);
        assert_eq!(texte_js(&json!(12.0)), "12");
    }

    #[test]
    fn script_embarque() {
        assert!(SCRIPT_EXTRACTION.contains("cfCheckpoint"));
        assert!(SCRIPT_EXTRACTION.contains("qlik-csrf-token"));
    }
}
