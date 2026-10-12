//! Calcul des lignes de la Grille (port de `src/features/grid/api/get-product-rows.ts`).
//!
//! Sept requêtes SQL en parallèle sur la base miroir FF, jointure avec le cache
//! réseau Qlik, report des gammes du dernier snapshot. Le résultat est gardé
//! 10 minutes en mémoire ([`super::rows_cache`]) et persisté dans `grid_rows`
//! (magasin « TOTAL » seulement), d'où il est resservi tant qu'il date du mois
//! en cours (`serveFromSnapshot`).

use super::months;
use super::network_trend::NB_MAGASINS_RESEAU;
use super::rows_cache::{self, GridRows, RowsFuture, SharedRows, StorePatchFuture};
use super::store::{read_grid_snapshot, upsert_grid_rows_shared};
use super::store_patch::{apply_store_patch_in_place, build_store_patch_entries, store_patch_candidates};
use super::types::{ProductRow, StorePatch, StorePatchEntry};
use crate::ff::api::{build_last12_months_range, get_mensuel_by_articles, FfArticle};
use crate::ff::pg::{self, PgStockRow};
use crate::qlik::network_cache::{get_network_metrics_by_code_centrale, NetworkMetricCached};
use futures::future::{BoxFuture, FutureExt};
use serde_json::{Map, Value};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

/// Paramètres de `getProductRows`. (`filters` n'est pas repris : le TS ne s'en
/// servait pas, la Grille filtre en local.)
#[derive(Debug, Clone, Default)]
pub struct GetProductRowsInput {
    pub code_fournisseur: String,
    /// `None` = « TOTAL ».
    pub magasin: Option<String>,
    pub force_refresh: bool,
}

impl GetProductRowsInput {
    pub fn total(code_fournisseur: &str, force_refresh: bool) -> Self {
        Self { code_fournisseur: code_fournisseur.to_string(), magasin: Some("TOTAL".into()), force_refresh }
    }
    fn magasin(&self) -> &str {
        self.magasin.as_deref().unwrap_or("TOTAL")
    }
}

/// Au-delà, l'instantané est servi mais un recalcul est relancé en arrière-plan.
const SNAPSHOT_REFRESH_AFTER: Duration = Duration::from_secs(20 * 60 * 60);

fn court(e: &dyn std::fmt::Display) -> String {
    crate::error::short(e, 200)
}

/// `Number(x) || 0` sur une valeur déjà numérique.
fn or0(v: f64) -> f64 {
    if v.is_nan() {
        0.0
    } else {
        v
    }
}

/// Rafraîchit UNIQUEMENT la colonne INIT (codeGammeInit = gamme serveur courante)
/// sur des lignes servies depuis le cache. La colonne Gamme (codeGamme) n'est pas
/// touchée : elle conserve la valeur issue du snapshot. Ainsi l'état serveur (INIT)
/// est toujours à jour à chaque chargement, même sur un hit du cache 10 min — et le
/// marqueur "modifié" (Gamme ≠ INIT) se résorbe dès que le serveur rattrape la modif.
async fn refresh_gamme_init(rows: &GridRows, code_fournisseur: &str) {
    match pg::pg_get_gammes_by_fournisseur(code_fournisseur).await {
        Ok(gamme_map) => appliquer_gammes_init(rows, &gamme_map),
        Err(e) => tracing::error!("[getProductRows] refreshGammeInit error: {}", court(&e)),
    }
}

fn appliquer_gammes_init(rows: &GridRows, gamme_map: &HashMap<String, String>) {
    if gamme_map.is_empty() {
        return;
    }
    for row in rows.rows.write().iter_mut() {
        if let Some(live) = gamme_map.get(&row.codein) {
            row.code_gamme_init = Some(live.clone());
        }
    }
}

/// Écrit l'instantané de grille lu par /api/v1 (table `grid_rows`).
///
/// Seul `magasin = TOTAL` est persisté : `ProductRow` embarque déjà les ventilations
/// par magasin (sales12mByStore, caByStore…), inutile de stocker trois variantes.
/// Toute erreur est avalée : la persistance ne doit jamais casser l'affichage.
async fn persist_grid_snapshot(input: &GetProductRowsInput, rows: &GridRows) {
    if input.magasin() != "TOTAL" {
        return;
    }
    match upsert_grid_rows_shared(&input.code_fournisseur, rows).await {
        Ok(n) => tracing::info!("[getProductRows] instantané persisté: {n} lignes pour {}", input.code_fournisseur),
        Err(e) => tracing::error!("[getProductRows] persistance grid_rows KO: {}", court(&e.message)),
    }
}

/// Lignes de la Grille d'un fournisseur (cache 10 min, instantané, sinon calcul).
pub fn get_product_rows(input: GetProductRowsInput) -> BoxFuture<'static, anyhow::Result<SharedRows>> {
    async move {
        let cache_key = rows_cache::grid_rows_cache_key(&input.code_fournisseur, input.magasin.as_deref());
        if !input.force_refresh {
            if let Some(cached) = rows_cache::get_fresh(&cache_key) {
                // La colonne INIT doit refléter l'état serveur à CHAQUE chargement,
                // y compris sur un hit de cache (les données lourdes restent, elles, cachées).
                refresh_gamme_init(&cached, &input.code_fournisseur).await;
                return Ok(cached);
            }
        }

        // Un calcul déjà en cours est réutilisé même en rechargement forcé : il part
        // de données fraîches, et en lancer un second en parallèle doublait la charge
        // (double clic, onglet rouvert…) sans rien apporter.
        if let Some(pending) = rows_cache::pending_get(&cache_key) {
            return pending.await.map_err(|e| anyhow::anyhow!(e));
        }

        // Instantané persisté (calcul de la nuit ou de la dernière ouverture) : servi
        // en une lecture au lieu d'un recalcul de 10 à 40 s. Jamais en rechargement
        // forcé — c'est précisément ce que l'utilisateur demande d'éviter.
        if !input.force_refresh {
            if let Some(servi) = serve_from_snapshot(&input, &cache_key).await {
                return Ok(servi);
            }
        }

        let version_au_depart = rows_cache::gamme_save_version(&input.code_fournisseur);
        // Le calcul est lancé à part, comme une promesse JS : il continue même si
        // l'appelant s'en va (client déconnecté), et il est partagé entre appelants.
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<SharedRows, String>>();
        let partage: RowsFuture =
            async move { rx.await.unwrap_or_else(|_| Err("calcul de la grille interrompu".to_string())) }.boxed().shared();
        rows_cache::pending_insert(&cache_key, partage.clone());
        let entree = input.clone();
        let cle = cache_key.clone();
        tokio::spawn(async move {
            let resultat = async {
                let mut rows = build_product_rows(&entree).await?;
                if rows_cache::gamme_save_version(&entree.code_fournisseur) != version_au_depart {
                    // Gammes enregistrées pendant le calcul : on reprend le dernier snapshot.
                    apply_snapshot_changes(&mut rows, load_latest_snapshot_changes(&entree.code_fournisseur).await.as_ref());
                }
                let shared = GridRows::new(rows);
                rows_cache::cache_grid_rows(&cle, shared.clone());
                rows_cache::pending_remove(&cle);
                // Persiste l'instantané pour /api/v1 : le calcul vient d'avoir lieu, on
                // arrête simplement de jeter le résultat. Volontairement NON bloquant —
                // l'affichage de la Grille ne doit pas attendre l'écriture.
                let a_persister = shared.clone();
                let code = entree.code_fournisseur.clone();
                let ecriture: Persistance =
                    tokio::spawn(async move { persist_grid_snapshot(&entree, &a_persister).await }).map(|_| ()).boxed().shared();
                PERSISTANCES.lock().insert(code.clone(), ecriture.clone());
                tokio::spawn(async move {
                    ecriture.clone().await;
                    let mut p = PERSISTANCES.lock();
                    if p.get(&code).map(|e| e.ptr_eq(&ecriture)).unwrap_or(false) {
                        p.remove(&code);
                    }
                });
                anyhow::Ok(shared)
            }
            .await;
            let resultat = resultat.map_err(|e| {
                rows_cache::pending_remove(&cle);
                format!("{e:#}")
            });
            let _ = tx.send(resultat);
        });
        partage.await.map_err(|e| anyhow::anyhow!(e))
    }
    .boxed()
}

/// Écriture de l'instantané en cours, par fournisseur.
type Persistance = futures::future::Shared<BoxFuture<'static, ()>>;
static PERSISTANCES: std::sync::LazyLock<parking_lot::Mutex<HashMap<String, Persistance>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Attend la fin de l'écriture de l'instantané lancée par le dernier calcul du
/// fournisseur (s'il y en a une en cours).
///
/// Écart volontaire avec le TS : `/api/v1` relisait `grid_rows` juste après un
/// calcul à la demande alors que la persistance, non attendue, pouvait ne pas
/// être finie — d'où un faux « aucun article ». Les routes attendent ici l'écriture.
pub async fn attendre_persistance(code_fournisseur: &str) {
    let en_cours = PERSISTANCES.lock().get(code_fournisseur).cloned();
    if let Some(e) = en_cours {
        e.await;
    }
}

/// `getProductRows({ codeFournisseur, magasin: "TOTAL", forceRefresh: true })` :
/// recalcul complet (synchro nocturne, préchauffage). Renvoie le nombre de lignes.
pub async fn get_product_rows_for_sync(code_fournisseur: &str) -> anyhow::Result<usize> {
    let rows = get_product_rows(GetProductRowsInput::total(code_fournisseur, true)).await?;
    Ok(rows.len())
}

/// Sert la Grille depuis `grid_rows` quand c'est possible : mêmes lignes que le
/// calcul en direct (elles en sont issues), avec la gamme FF du moment (INIT) et
/// les dernières gammes enregistrées reportées dessus. Hors « tous magasins »,
/// le rattrapage du magasin choisi est appliqué comme après un calcul.
///
/// `None` = pas d'instantané utilisable (absent, ancien format, autre mois) :
/// l'appelant recalcule.
async fn serve_from_snapshot(input: &GetProductRowsInput, cache_key: &str) -> Option<SharedRows> {
    let code = input.code_fournisseur.as_str();
    let magasin = input.magasin();
    let snapshot = match read_grid_snapshot(code).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[getProductRows] lecture grid_rows KO: {}", court(&e.message));
            return None;
        }
    };
    let snapshot = snapshot.filter(|s| !s.rows.is_empty())?;
    let computed_at = snapshot.computed_at;
    let mut rows = snapshot.rows;

    // Les colonnes réseau de l'instantané datent de son calcul : on les relit dans
    // le cache Qlik, comme le calcul en direct. Sans cela, une synchro Qlik faite
    // depuis (au changement de mois notamment) restait invisible jusqu'au
    // prochain recalcul, et la tendance réseau disparaissait.
    let codes: Vec<String> = rows.iter().map(|r| r.code_centrale.clone().unwrap_or_default()).collect();
    let (changes, network, gammes) =
        tokio::join!(load_latest_snapshot_changes(code), fetch_network_metrics(&codes), pg::pg_get_gammes_by_fournisseur(code));
    match gammes {
        Ok(g) if !g.is_empty() => {
            for row in rows.iter_mut() {
                if let Some(live) = g.get(&row.codein) {
                    row.code_gamme_init = Some(live.clone());
                }
            }
        }
        Ok(_) => {}
        Err(e) => tracing::error!("[getProductRows] refreshGammeInit error: {}", court(&e)),
    }
    apply_snapshot_changes(&mut rows, changes.as_ref());
    enrich_with_network_metrics(&mut rows, network.as_ref());

    if magasin != "TOTAL" {
        let range = build_last12_months_range();
        reconcile_selected_store_from_mensuel_api(&mut rows, magasin, &range.date_debut, &range.date_fin, &last12_periods()).await;
    }

    let shared = GridRows::new(rows);
    rows_cache::cache_grid_rows(cache_key, shared.clone());

    // Instantané qui n'a pas été recalculé par la nuit : on le rafraîchit sans
    // faire attendre l'utilisateur (la prochaine ouverture en profitera).
    // Toujours le calcul « tous magasins » : c'est lui qui réécrit l'instantané.
    let age = chrono::Utc::now().naive_utc() - computed_at;
    if age.to_std().map(|d| d > SNAPSHOT_REFRESH_AFTER).unwrap_or(false)
        && !rows_cache::pending_contains(&rows_cache::grid_rows_cache_key(code, Some("TOTAL")))
    {
        let code = code.to_string();
        tokio::spawn(async move {
            if let Err(e) = get_product_rows(GetProductRowsInput::total(&code, true)).await {
                tracing::error!("[getProductRows] rafraîchissement en arrière-plan KO: {}", court(&e));
            }
        });
    }
    Some(shared)
}

/// Les 12 derniers mois complets, clés « YYYYMM » triées (même fenêtre que le calcul).
fn last12_periods() -> Vec<String> {
    months::get_last12_months(months::today())
}

#[derive(Default, Clone, Copy)]
struct PeriodData {
    qty: f64,
    ca: f64,
    marge: f64,
    stock: f64,
    receptions: f64,
}

/// `Math.max(...valeurs)` : `NaN` si l'une l'est.
fn js_max(valeurs: impl Iterator<Item = f64>) -> f64 {
    valeurs.fold(f64::NEG_INFINITY, |m, v| if m.is_nan() || v.is_nan() { f64::NAN } else { m.max(v) })
}

/// Le calcul complet (`buildProductRows`).
async fn build_product_rows(input: &GetProductRowsInput) -> anyhow::Result<Vec<ProductRow>> {
    let code_fournisseur = input.code_fournisseur.as_str();
    let magasin = input.magasin();
    tracing::info!("\n>>> [getProductRows] supplier: {code_fournisseur}, magasin: {magasin}");

    let range = build_last12_months_range();
    let (date_debut, date_fin) = (range.date_debut.as_str(), range.date_fin.as_str());

    // ─── Phase 1 : 7 requêtes SQL en parallèle ────────────────────────────
    // Phases 8 et 9 lancées dès maintenant : elles n'attendent que la liste des
    // articles (codes centraux) ou le seul code fournisseur.
    let articles_et_reseau = async {
        let articles = pg::pg_get_articles_by_fournisseur(code_fournisseur).await.unwrap_or_else(|e| {
            tracing::error!("[getProductRows] pgGetArticlesByFournisseur ERROR: {e:#}");
            vec![]
        });
        let codes: Vec<String> = articles
            .iter()
            .map(|a| a.code_centrale.as_deref().filter(|c| !c.is_empty()).map(|c| c.trim().to_string()).unwrap_or_default())
            .collect();
        let network = fetch_network_metrics(&codes).await;
        (articles, network)
    };
    let ou_vide = |nom: &'static str| move |e: &anyhow::Error| tracing::error!("[getProductRows] {nom} ERROR: {e:#}");
    let ((articles, network), mensuel_rows, gamme_map, nom_map, stock_map, commandes_map, prix_vente_map, snapshot_changes) = tokio::join!(
        articles_et_reseau,
        async {
            pg::pg_get_mensuel_by_fournisseur(code_fournisseur, date_debut, date_fin)
                .await
                .inspect_err(ou_vide("pgGetMensuelByFournisseur"))
                .unwrap_or_default()
        },
        async {
            pg::pg_get_gammes_by_fournisseur(code_fournisseur).await.inspect_err(ou_vide("pgGetGammesByFournisseur")).unwrap_or_default()
        },
        async {
            pg::pg_get_nomenclature_by_fournisseur(code_fournisseur)
                .await
                .inspect_err(ou_vide("pgGetNomenclatureByFournisseur"))
                .unwrap_or_default()
        },
        async {
            pg::pg_get_stock_by_fournisseur(code_fournisseur).await.inspect_err(ou_vide("pgGetStockByFournisseur")).unwrap_or_default()
        },
        async {
            pg::pg_get_commandes_by_fournisseur(code_fournisseur)
                .await
                .inspect_err(ou_vide("pgGetCommandesByFournisseur"))
                .unwrap_or_default()
        },
        async {
            pg::pg_get_prix_vente_by_fournisseur(code_fournisseur)
                .await
                .inspect_err(ou_vide("pgGetPrixVenteByFournisseur"))
                .unwrap_or_default()
        },
        load_latest_snapshot_changes(code_fournisseur),
    );

    tracing::info!("[getProductRows] {} articles, {} mensuel rows, {} gammes", articles.len(), mensuel_rows.len(), gamme_map.len());

    // ─── Phase 2 : Fenêtre temporelle 12 mois complets ───────────────────
    let sorted_periods = last12_periods();

    // ─── Phase 3 : Seed productMap depuis articles ────────────────────────
    // Ordre d'insertion conservé (Map JS) : index par codein.
    let mut products: Vec<ProductRow> = Vec::with_capacity(articles.len());
    let mut index: HashMap<String, usize> = HashMap::with_capacity(articles.len());
    for art in &articles {
        if art.codein.is_empty() || index.contains_key(&art.codein) {
            continue;
        }
        index.insert(art.codein.clone(), products.len());
        let non_nul = |v: Option<f64>| v.filter(|x| *x != 0.0 && !x.is_nan());
        products.push(ProductRow {
            codein: art.codein.clone(),
            code_fournisseur: art.codefou.clone(),
            nom_fournisseur: art.nomfou.clone().unwrap_or_default(),
            fournisseur_principal_code: art.codefou_principal.clone(),
            fournisseur_principal_nom: art.nomfou_principal.clone(),
            libelle1: art.libelle1.clone().unwrap_or_default(),
            gtin: art.gtin.clone().unwrap_or_default(),
            reference: art.reference.clone().unwrap_or_default(),
            code_centrale: art.code_centrale.as_deref().filter(|c| !c.is_empty()).map(|c| c.trim().to_string()),
            code_gamme: None,
            code_gamme_init: None,
            code_gamme_draft: None,
            total_quantite: 0.0,
            total_ca: 0.0,
            total_marge: 0.0,
            taux_marge: 0.0,
            working_stores: vec![],
            noid: (art.no_id != 0).then_some(art.no_id as f64),
            pcb: non_nul(art.pcb),
            prix_vente: non_nul(art.pv_central),
            ..Default::default()
        });
    }

    // ─── Phase 4 : Agréger mensuelRows → byPeriod par codein ─────────────
    // SQL a déjà fait l'agrégation par (codein, site, mois).
    // On somme les 2 sites (TOTAL) ET on accumule par site pour le switch client-side.
    let allowed: BTreeSet<&str> = sorted_periods.iter().map(String::as_str).collect();
    let mut mensuel_by_codein: Vec<(String, HashMap<String, PeriodData>)> = Vec::new();
    let mut mensuel_index: HashMap<String, usize> = HashMap::new();
    let mut mensuel_by_site: HashMap<String, BTreeMap<String, HashMap<String, PeriodData>>> = HashMap::new();
    let mut store_months: HashMap<String, BTreeSet<String>> = HashMap::new();

    for row in &mensuel_rows {
        let periode = row.mois.replacen('-', "", 1); // "2026-02" → "202602"
        if !allowed.contains(periode.as_str()) {
            continue;
        }
        let stock = or0(row.stock_fin_mois.unwrap_or(f64::NAN));
        // Accumulation TOTAL (toujours tous sites)
        let i = *mensuel_index.entry(row.codein.clone()).or_insert_with(|| {
            mensuel_by_codein.push((row.codein.clone(), HashMap::new()));
            mensuel_by_codein.len() - 1
        });
        let p = mensuel_by_codein[i].1.entry(periode.clone()).or_default();
        p.stock += stock;
        p.qty += or0(row.qte_vendue);
        p.ca += or0(row.ca_ht);
        p.marge += or0(row.marge);
        p.receptions += or0(row.qte_recue);

        // Accumulation par site (pour switch client-side)
        let sp = mensuel_by_site.entry(row.codein.clone()).or_default().entry(row.site.clone()).or_default().entry(periode).or_default();
        sp.qty += or0(row.qte_vendue);
        sp.ca += or0(row.ca_ht);
        sp.marge += or0(row.marge);
        sp.stock = stock; // SQL donne déjà le dernier mouvement
        sp.receptions += or0(row.qte_recue);

        // Suivi magasins actifs (pour workingStores) : 1 vente suffit
        if row.qte_vendue > 0.0 {
            store_months.entry(row.codein.clone()).or_default().insert(row.site.clone());
        }
    }

    // ─── Phase 5 : Remplir ProductRow depuis mensuelByCodein ─────────────
    for (codein, by_period) in &mensuel_by_codein {
        let Some(&pi) = index.get(codein) else { continue };
        let product = &mut products[pi];

        let mut last_stock = 0.0;
        for periode in &sorted_periods {
            match by_period.get(periode) {
                Some(p) => {
                    product.sales12m.insert(periode.clone(), p.qty);
                    product.stock12m.insert(periode.clone(), p.stock);
                    product.receptions12m.insert(periode.clone(), p.receptions);
                    product.total_quantite += p.qty;
                    product.total_ca += p.ca;
                    product.total_marge += p.marge;
                    last_stock = p.stock;
                }
                None => {
                    product.sales12m.insert(periode.clone(), 0.0);
                    product.stock12m.insert(periode.clone(), last_stock); // carry-forward
                    product.receptions12m.insert(periode.clone(), 0.0);
                }
            }
        }

        product.taux_marge = if product.total_ca > 0.0 { (product.total_marge / product.total_ca) * 100.0 } else { 0.0 };

        // Breakdowns par site pour le switch client-side
        if let Some(site_map) = mensuel_by_site.get(codein) {
            let mut sales_by_store = BTreeMap::new();
            let mut stock_by_store = BTreeMap::new();
            let mut receptions_by_store = BTreeMap::new();
            let mut ca_by_store = BTreeMap::new();
            let mut quantite_by_store = BTreeMap::new();
            let mut marge_by_store = BTreeMap::new();
            for (site, site_by_period) in site_map {
                let (mut sales, mut stock, mut receptions) = (BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
                let (mut s_qty, mut s_ca, mut s_marge) = (0.0, 0.0, 0.0);
                let mut last_site_stock = 0.0;
                for periode in &sorted_periods {
                    let sp = site_by_period.get(periode);
                    sales.insert(periode.clone(), sp.map(|p| p.qty).unwrap_or(0.0));
                    receptions.insert(periode.clone(), sp.map(|p| p.receptions).unwrap_or(0.0));
                    match sp {
                        Some(p) => {
                            stock.insert(periode.clone(), p.stock);
                            last_site_stock = p.stock;
                        }
                        None => {
                            stock.insert(periode.clone(), last_site_stock); // carry-forward
                        }
                    }
                    s_qty += sp.map(|p| p.qty).unwrap_or(0.0);
                    s_ca += sp.map(|p| p.ca).unwrap_or(0.0);
                    s_marge += sp.map(|p| p.marge).unwrap_or(0.0);
                }
                sales_by_store.insert(site.clone(), sales);
                stock_by_store.insert(site.clone(), stock);
                receptions_by_store.insert(site.clone(), receptions);
                quantite_by_store.insert(site.clone(), s_qty);
                ca_by_store.insert(site.clone(), s_ca);
                marge_by_store.insert(site.clone(), s_marge);
            }

            // Le stock TOTAL se recalcule ici, à partir des séries par site.
            //
            // Il était sommé plus haut depuis les lignes mensuelles brutes, ce
            // qui perdait tout magasin SANS MOUVEMENT dans le mois : le stock
            // est un niveau, pas un flux — un magasin qui n'a rien vendu ni reçu
            // détient toujours sa marchandise. Les séries par site, elles, sont
            // reportées d'un mois sur l'autre : leur somme est la bonne.
            if !stock_by_store.is_empty() {
                for periode in &sorted_periods {
                    let total: f64 = stock_by_store.values().map(|s: &BTreeMap<String, f64>| s.get(periode).copied().unwrap_or(0.0)).sum();
                    product.stock12m.insert(periode.clone(), total);
                }
            }
            product.sales12m_by_store = Some(sales_by_store);
            product.stock12m_by_store = Some(stock_by_store);
            product.receptions12m_by_store = Some(receptions_by_store);
            product.ca_by_store = Some(ca_by_store);
            product.quantite_by_store = Some(quantite_by_store);
            product.marge_by_store = Some(marge_by_store);
        }

        // workingStores : sites avec au moins 1 vente sur les 12 derniers mois
        if let Some(sites) = store_months.get(codein) {
            product.working_stores = sites.iter().cloned().collect();
        }

        // Commandes en cours
        if let Some(&cmd) = commandes_map.get(codein) {
            if cmd != 0.0 && !cmd.is_nan() {
                product.commandes_en_cours = Some(cmd);
            }
        }
    }

    // ─── Phase 6 : Gammes (saison active) ────────────────────────────────
    for (codein, gamme) in &gamme_map {
        let Some(&pi) = index.get(codein) else { continue };
        products[pi].code_gamme_init = Some(gamme.clone());
        products[pi].code_gamme = Some(gamme.clone());
    }

    // ─── Phase 6b : Nomenclature (famille / sous-famille) ────────────────
    for (codein, nom) in &nom_map {
        let Some(&pi) = index.get(codein) else { continue };
        let p = &mut products[pi];
        p.code3 = nom.code3.clone();
        p.libelle3 = nom.libelle3.clone();
        p.code2 = nom.code2.clone().unwrap_or_default();
        p.libelle_niveau2 = nom.libelle2.clone().unwrap_or_default();
        p.code1 = nom.code1.clone().unwrap_or_default();
        p.libelle_niveau1 = nom.libelle1nom.clone().unwrap_or_default();
    }

    // ─── Phase 7 : Stock temps réel (cube_stock) ─────────────────────────
    for (codein, stocks) in &stock_map {
        let Some(&pi) = index.get(codein) else { continue };
        let product = &mut products[pi];
        let somme = |f: fn(&PgStockRow) -> Option<f64>| stocks.iter().map(|r| or0(f(r).unwrap_or(f64::NAN))).sum::<f64>();
        product.stock_actuel = Some(somme(|r| r.stockdispo));
        product.stock_total = Some(somme(|r| r.qte));
        product.stock_valeur = Some(somme(|r| r.valstock));

        if let Some(prmp) = stocks.iter().filter_map(|r| r.prmp).find(|p| *p > 0.0) {
            product.pa = Some(prmp);
            product.prix_achat = Some(prmp);
        }

        let plus_recente = |dates: Vec<&String>| -> String {
            dates.into_iter().fold(String::new(), |best, d| if !d.is_empty() && *d > best { d.clone() } else { best })
        };
        let dern_vente = plus_recente(stocks.iter().filter_map(|r| r.dernierevente.as_ref()).collect());
        if !dern_vente.is_empty() {
            product.derniere_vente = Some(dern_vente);
        }
        let dern_liv = plus_recente(stocks.iter().filter_map(|r| r.dernierereception.as_ref()).collect());
        if !dern_liv.is_empty() {
            product.derniere_livraison = Some(dern_liv);
        }

        // Map store-specific delivery dates
        let mut par_site = BTreeMap::new();
        for r in stocks {
            if let Some(d) = r.dernierereception.as_ref().filter(|d| !d.is_empty() && !r.site.is_empty()) {
                par_site.insert(r.site.clone(), d.clone());
            }
        }
        product.derniere_livraison_by_store = Some(par_site);
    }

    // ─── Phase 7b : Prix de vente (cube_pv, sinon le PV du cube de stock) ─
    //
    // Le vrai prix vit dans `cube_pv`, par article ET par site. On garde le
    // détail par magasin — deux magasins peuvent ne pas pratiquer le même prix,
    // et l'afficher vaut mieux que le moyenner.
    for product in products.iter_mut() {
        match prix_vente_map.get(&product.codein).filter(|m| !m.is_empty()) {
            Some(par_site) => product.prix_vente_by_store = Some(par_site.clone()),
            None => {
                // Filet de secours : le cube de stock porte le même PV, mais
                // seulement pour les articles qui ont une ligne de stock.
                let mut depuis_stock = BTreeMap::new();
                for s in stock_map.get(&product.codein).map(|v| v.as_slice()).unwrap_or_default() {
                    let pv = s.pv.unwrap_or(f64::NAN);
                    let site = s.site.trim();
                    if !site.is_empty() && pv.is_finite() && pv > 0.0 {
                        depuis_stock.insert(site.to_string(), pv);
                    }
                }
                if !depuis_stock.is_empty() {
                    product.prix_vente_by_store = Some(depuis_stock);
                }
            }
        }
        // Le plus élevé quand les magasins divergent : une moyenne inventerait
        // un prix qu'aucune caisse ne pratique. L'écart est signalé à l'écran.
        if let Some(prix) = product.prix_vente_by_store.as_ref().filter(|m| !m.is_empty()) {
            product.prix_vente = Some(js_max(prix.values().copied()));
        }
    }

    // ─── Phase 8 : Données réseau Qlik (CA / Qté / nb magasins par code centrale) ──
    enrich_with_network_metrics(&mut products, network.as_ref());

    // ─── Phase 9 : Restaurer gammes depuis dernier snapshot ──────────────
    // La colonne Gamme (codeGamme) conserve la valeur du snapshot telle quelle.
    // La colonne INIT (codeGammeInit) reste, elle, l'état LIVE du serveur
    // rechargé en Phase 6 — jamais écrasée ici.
    apply_snapshot_changes(&mut products, snapshot_changes.as_ref());

    // ─── Phase 10 : Filtrer gamme Y sans ventes ──────────────────────────
    let tous = products.len();
    let mut rows: Vec<ProductRow> =
        products.into_iter().filter(|p| p.code_gamme.as_deref() != Some("Y") || p.total_quantite > 0.0).collect();
    reconcile_selected_store_from_mensuel_api(&mut rows, magasin, date_debut, date_fin, &sorted_periods).await;
    let exclus_y = tous - rows.len();
    tracing::info!(
        "[getProductRows] {} produits ({exclus_y} gamme Y sans ventes exclus), {} avec ventes",
        rows.len(),
        mensuel_by_codein.len()
    );

    Ok(rows)
}

/// Articles complétés par l'API FF, au plus, lors d'un changement de magasin
/// (`GRID_STORE_RECONCILE_MAX`, 300 par défaut).
fn plafond_complement() -> f64 {
    match std::env::var("GRID_STORE_RECONCILE_MAX") {
        Ok(v) => super::js::js_number_from_str(&v),
        Err(_) => 300.0,
    }
}

/// `candidates.slice(0, plafond)`.
fn js_slice_end(len: usize, fin: f64) -> usize {
    if fin.is_nan() {
        return 0;
    }
    let fin = fin.trunc();
    if fin < 0.0 {
        (len as f64 + fin).max(0.0) as usize
    } else {
        fin.min(len as f64) as usize
    }
}

/// Article candidat au complément, copié hors verrou.
struct Candidat {
    codein: String,
    libelle1: String,
    codefou: String,
    noid: Option<f64>,
}

fn candidats(rows: &[ProductRow], magasin: &str) -> Vec<Candidat> {
    store_patch_candidates(rows, magasin)
        .into_iter()
        .map(|r| Candidat { codein: r.codein.clone(), libelle1: r.libelle1.clone(), codefou: r.code_fournisseur.clone(), noid: r.noid })
        .collect()
}

/// Interroge l'API FF pour les articles du magasin à compléter (cf. store-patch).
async fn fetch_store_patch_entries(
    candidates: Vec<Candidat>,
    magasin: &str,
    date_debut: &str,
    date_fin: &str,
    periods: &[String],
) -> Vec<StorePatchEntry> {
    if candidates.is_empty() {
        return vec![];
    }

    // Ce rattrapage fait UNE requête HTTP par article : sur un gros fournisseur,
    // les candidats se comptent par milliers et le changement de magasin se fige
    // plusieurs minutes. On le borne, et on dit ce qui a été laissé de côté
    // plutôt que de tronquer en silence.
    let nb = candidates.len();
    let retenus = &candidates[..js_slice_end(nb, plafond_complement())];
    if nb > retenus.len() {
        tracing::warn!(
            "[getProductRows] rattrapage magasin {magasin} borné à {} articles sur {nb} : les autres gardent la valeur SQL.",
            retenus.len()
        );
    }

    let articles: Vec<FfArticle> = retenus
        .iter()
        .map(|c| FfArticle {
            codein: c.codein.clone(),
            libelle1: c.libelle1.clone(),
            codefou: c.codefou.clone(),
            noid: c.noid.filter(|n| n.is_finite()).map(|n| n as i64),
            ..Default::default()
        })
        .collect();
    let mensuel_map = get_mensuel_by_articles(&articles, date_debut, date_fin, 25).await;
    let codes: Vec<String> = retenus.iter().map(|c| c.codein.clone()).collect();
    build_store_patch_entries(&codes, magasin, periods, &mensuel_map)
}

async fn reconcile_selected_store_from_mensuel_api(
    rows: &mut [ProductRow],
    magasin: &str,
    date_debut: &str,
    date_fin: &str,
    sorted_periods: &[String],
) {
    if magasin == "TOTAL" {
        return;
    }
    let entries = fetch_store_patch_entries(candidats(rows, magasin), magasin, date_debut, date_fin, sorted_periods).await;
    let fixed = apply_store_patch_in_place(rows, magasin, sorted_periods, &entries);
    if fixed > 0 {
        tracing::info!("[getProductRows] {fixed} produits corrigés via API mensuelle pour magasin {magasin}");
    }
}

/// Complément de l'API FF pour un magasin, calculé sur les lignes « tous
/// magasins » (jamais modifiées ici). La Grille l'applique à son arrivée, sans
/// recharger les lignes. Les demandes simultanées partagent le même calcul, et
/// un échec n'est jamais gardé.
pub async fn get_store_patch(code_fournisseur: &str, magasin: &str) -> anyhow::Result<Arc<StorePatch>> {
    let rows = match rows_cache::peek_fresh(&rows_cache::grid_rows_cache_key(code_fournisseur, Some("TOTAL"))) {
        Some(r) => r,
        None => get_product_rows(GetProductRowsInput::total(code_fournisseur, false)).await?,
    };

    let patch: StorePatchFuture = {
        let mut table = rows.store_patches.lock();
        match table.get(magasin) {
            Some(p) => p.clone(),
            None => {
                let periods = last12_periods();
                let range = build_last12_months_range();
                let candidates = candidats(&rows.rows.read(), magasin);
                let magasin_s = magasin.to_string();
                let (tx, rx) = tokio::sync::oneshot::channel();
                tokio::spawn(async move {
                    let entries = fetch_store_patch_entries(candidates, &magasin_s, &range.date_debut, &range.date_fin, &periods).await;
                    let _ = tx.send(Ok(Arc::new(StorePatch { magasin: magasin_s, periods, entries })));
                });
                let en_cours: StorePatchFuture =
                    async move { rx.await.unwrap_or_else(|_| Err("complément interrompu".to_string())) }.boxed().shared();
                table.insert(magasin.to_string(), en_cours.clone());
                en_cours
            }
        }
    };
    match patch.clone().await {
        Ok(p) => Ok(p),
        Err(e) => {
            let mut table = rows.store_patches.lock();
            if table.get(magasin).map(|p| p.ptr_eq(&patch)).unwrap_or(false) {
                table.remove(magasin);
            }
            Err(anyhow::anyhow!(e))
        }
    }
}

/// Extrait la série « nombre de magasins vendeurs » du détail mensuel complet.
///
/// Un mois PRÉSENT dans le détail est un mois extrait : s'il n'a pas de `nbMag`,
/// c'est qu'aucun magasin n'a vendu, donc zéro. Renvoie `None` plutôt qu'un objet
/// vide pour que l'UI distingue « pas de donnée » de « zéro magasin ».
fn nb_mag_par_mois(m: &NetworkMetricCached) -> Option<BTreeMap<String, f64>> {
    let detail = m.metrics_by_month.as_ref()?;
    let par_mois: BTreeMap<String, f64> =
        detail.iter().map(|(mois, v)| (mois.clone(), v.nb_mag.filter(|n| n.is_finite()).unwrap_or(0.0))).collect();
    (!par_mois.is_empty()).then_some(par_mois)
}

/// Phase 9 : la colonne Gamme (codeGamme) reprend la valeur du snapshot ;
/// codeGammeInit reste figé (état serveur).
pub fn apply_snapshot_changes(rows: &mut [ProductRow], changes: Option<&Map<String, Value>>) {
    let Some(changes) = changes else { return };
    for row in rows.iter_mut() {
        let after = changes.get(&row.codein).and_then(|c| c.get("after"));
        if super::js::js_truthy(after) {
            row.code_gamme = Some(super::js::js_string(after));
        }
    }
}

/// Dernières gammes enregistrées pour ce fournisseur (Phase 9), ou `None`.
pub async fn load_latest_snapshot_changes(code_fournisseur: &str) -> Option<Map<String, Value>> {
    let res = async {
        let pool = crate::db::pool().map_err(|e| anyhow::anyhow!(e.message))?;
        let row = sqlx::query("select changes from session_snapshots where code_fournisseur = $1 order by created_at desc limit 1")
            .bind(code_fournisseur)
            .fetch_optional(&pool)
            .await?;
        anyhow::Ok(row.map(|r| r.try_get::<Value, _>("changes")).transpose()?)
    }
    .await;
    match res {
        Ok(Some(Value::Object(m))) => Some(m),
        Ok(_) => None,
        Err(e) => {
            tracing::error!("[getProductRows] Snapshot restore error: {e:#}");
            None
        }
    }
}

/// Lit les métriques réseau Qlik (cache qlik_network_metrics) des codes centraux
/// donnés. `None` en cas d'erreur : la grille s'affiche alors sans données réseau.
async fn fetch_network_metrics(codes_centrale: &[String]) -> Option<HashMap<String, NetworkMetricCached>> {
    let mut vus = BTreeSet::new();
    let codes: Vec<String> = codes_centrale.iter().filter(|c| !c.is_empty() && vus.insert(c.as_str())).cloned().collect();
    if codes.is_empty() {
        return None;
    }
    match get_network_metrics_by_code_centrale(&codes).await {
        Ok(m) => Some(m),
        Err(e) => {
            tracing::error!("[getProductRows] enrichWithNetworkMetrics error: {e:#}");
            None
        }
    }
}

/// Enrichit les produits avec les métriques réseau Qlik, jointes par code centrale.
/// Dégradation propre si la sync Qlik n'a jamais tourné ou si le code centrale
/// n'est pas encore disponible.
pub fn enrich_with_network_metrics(products: &mut [ProductRow], metrics: Option<&HashMap<String, NetworkMetricCached>>) {
    let Some(metrics) = metrics.filter(|m| !m.is_empty()) else { return };
    for product in products.iter_mut() {
        let Some(m) = product.code_centrale.as_deref().filter(|c| !c.is_empty()).and_then(|c| metrics.get(c)) else { continue };
        product.ca_reseau = Some(m.ca_reseau);
        product.qte_reseau = Some(m.qte_reseau);
        product.nb_magasins_reseau = Some(m.nb_magasins_reseau);
        product.ca_par_magasin_reseau = Some(m.ca_par_magasin_reseau);
        product.marge_pct_reseau = Some(m.marge_pct_reseau);
        product.taux_presence_reseau = Some(m.nb_magasins_reseau / NB_MAGASINS_RESEAU);
        product.qte_reseau_by_month = Some(m.qte_by_month.clone());
        product.nb_mag_reseau_by_month = Some(nb_mag_par_mois(m));
        product.network_fetched_at = m.fetched_at.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_et_max_comme_js() {
        assert_eq!(js_slice_end(10, 300.0), 10);
        assert_eq!(js_slice_end(10, 3.7), 3);
        assert_eq!(js_slice_end(10, -2.0), 8);
        assert_eq!(js_slice_end(10, f64::NAN), 0);
        assert_eq!(js_max([1.0, 3.0, 2.0].into_iter()), 3.0);
        assert!(js_max([1.0, f64::NAN].into_iter()).is_nan());
    }

    #[test]
    fn report_des_gammes_du_snapshot() {
        let mut rows = vec![
            ProductRow { codein: "1".into(), code_gamme: Some("B".into()), ..Default::default() },
            ProductRow { codein: "2".into(), code_gamme: Some("B".into()), ..Default::default() },
            ProductRow { codein: "3".into(), code_gamme: Some("B".into()), ..Default::default() },
        ];
        let changes = serde_json::json!({ "1": { "before": "B", "after": "Z" }, "2": { "before": "B", "after": "" } });
        apply_snapshot_changes(&mut rows, changes.as_object());
        let g: Vec<_> = rows.iter().map(|r| r.code_gamme.as_deref().unwrap()).collect();
        assert_eq!(g, vec!["Z", "B", "B"]);
    }
}
