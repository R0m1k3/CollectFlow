//! Cache mémoire des lignes de grille calculées (partie « cache » de
//! `src/features/grid/api/get-product-rows.ts`).
//!
//! Clé : `"{codeFournisseur}:{magasin ?? "TOTAL"}"`. Durée de vie : 10 minutes.
//! Le calcul lui-même (`getProductRows`, `buildProductRows`, `serveFromSnapshot`,
//! `getStorePatch`) viendra en phase 2 et s'appuie sur les briques ci-dessous :
//!
//! - [`get_fresh`] : lecture d'une entrée de moins de 10 min, remontée en tête de
//!   l'ordre d'usage (éviction LRU) ; [`peek_fresh`] la lit sans la remonter
//!   (`getStorePatch`) ;
//! - [`cache_grid_rows`] : insertion avec éviction (`cacheGridRows`) ;
//! - [`pending_get`] / [`pending_insert`] / [`pending_remove`] : calculs en cours,
//!   partagés entre appels simultanés (`gridRowsPending`) ;
//! - [`gamme_save_version`] : compteur d'enregistrements de gammes par fournisseur,
//!   qu'un calcul compare avant/après pour relire le dernier snapshot ;
//! - [`invalidate_grid_rows_cache`], [`patch_grid_rows_cache`].
//!
//! Les lignes d'une entrée sont partagées ([`SharedRows`]) et modifiées sur place,
//! comme le tableau JS : `patchGridRowsCache` et `refreshGammeInit` écrivent dans
//! les lignes déjà servies. Les compléments par magasin (`storePatches`, une
//! `WeakMap` indexée par le tableau en TS) sont rattachés au même objet : ils
//! vivent et meurent avec lui.

use super::types::{GammeCode, ProductRow, StorePatch};
use futures::future::{BoxFuture, Shared};
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

pub const GRID_ROWS_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// Bornes du cache mémoire. La synchro nocturne et le préchauffage passent par
/// `getProductRows()` pour CHAQUE fournisseur : sans plafond, le processus finissait
/// par garder toutes les grilles en mémoire (plusieurs centaines de Mo). Ordre
/// d'insertion = ordre d'usage : on évince les entrées les moins récemment servies.
///
/// `Number(process.env.X ?? défaut)` : une valeur illisible donne `NaN`, et toute
/// comparaison avec `NaN` est fausse — comportement conservé.
fn borne(nom: &str, defaut: f64) -> f64 {
    match std::env::var(nom) {
        Ok(v) => super::js::js_number_from_str(&v),
        Err(_) => defaut,
    }
}
fn max_entries() -> f64 {
    borne("GRID_ROWS_CACHE_MAX_ENTRIES", 30.0)
}
fn max_rows() -> f64 {
    borne("GRID_ROWS_CACHE_MAX_ROWS", 150_000.0)
}

/// Complément par magasin en cours de calcul ou calculé (partagé entre appelants).
pub type StorePatchFuture = Shared<BoxFuture<'static, Result<Arc<StorePatch>, String>>>;

/// Lignes d'une entrée du cache, partagées et modifiables sur place.
#[derive(Default)]
pub struct GridRows {
    pub rows: RwLock<Vec<ProductRow>>,
    /// `storePatches` : magasin → complément, rattaché à ce tableau de lignes.
    pub store_patches: Mutex<HashMap<String, StorePatchFuture>>,
}

impl GridRows {
    pub fn new(rows: Vec<ProductRow>) -> SharedRows {
        Arc::new(GridRows { rows: RwLock::new(rows), store_patches: Mutex::new(HashMap::new()) })
    }
    pub fn len(&self) -> usize {
        self.rows.read().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Copie des lignes (pour les sérialiser hors verrou).
    pub fn snapshot(&self) -> Vec<ProductRow> {
        self.rows.read().clone()
    }
}

pub type SharedRows = Arc<GridRows>;

/// Calcul en cours, partagé : l'erreur est un message (le calcul TS relance l'erreur
/// à chaque appelant).
pub type RowsFuture = Shared<BoxFuture<'static, Result<SharedRows, String>>>;

struct Entree {
    rows: SharedRows,
    created_at: Instant,
}

#[derive(Default)]
struct Etat {
    /// Entrées dans l'ordre d'usage (la plus ancienne en tête).
    cache: Vec<(String, Entree)>,
    pending: HashMap<String, RowsFuture>,
    /// Nombre d'enregistrements de gammes par fournisseur (cf. [`patch_grid_rows_cache`]).
    gamme_save_version: HashMap<String, u64>,
}

static ETAT: LazyLock<Mutex<Etat>> = LazyLock::new(|| Mutex::new(Etat::default()));

/// `gridRowsCacheKey` : `"{codeFournisseur}:{magasin ?? "TOTAL"}"`.
pub fn grid_rows_cache_key(code_fournisseur: &str, magasin: Option<&str>) -> String {
    format!("{code_fournisseur}:{}", magasin.unwrap_or("TOTAL"))
}

fn prefixe(code_fournisseur: &str) -> String {
    format!("{code_fournisseur}:")
}

/// `cacheGridRows` : (ré)insère l'entrée en fin d'ordre d'usage, puis évince les
/// plus anciennes tant que les bornes sont dépassées (jamais la dernière).
pub fn cache_grid_rows(key: &str, rows: SharedRows) {
    let (max_e, max_r) = (max_entries(), max_rows());
    let mut etat = ETAT.lock();
    etat.cache.retain(|(k, _)| k != key);
    etat.cache.push((key.to_string(), Entree { rows, created_at: Instant::now() }));
    let mut total_rows: f64 = etat.cache.iter().map(|(_, e)| e.rows.len() as f64).sum();
    while etat.cache.len() > 1 {
        let taille = etat.cache.len() as f64;
        if taille <= max_e && total_rows <= max_r {
            break;
        }
        let (_, e) = etat.cache.remove(0);
        total_rows -= e.rows.len() as f64;
    }
}

/// Entrée de moins de 10 min, remontée en tête de l'ordre d'usage (hit de
/// `getProductRows`). `None` si absente ou expirée.
pub fn get_fresh(key: &str) -> Option<SharedRows> {
    let mut etat = ETAT.lock();
    let pos = etat.cache.iter().position(|(k, e)| k == key && e.created_at.elapsed() < GRID_ROWS_CACHE_TTL)?;
    // Remonte l'entrée en tête de l'ordre d'usage (éviction LRU), sans changer
    // sa date de création.
    let entree = etat.cache.remove(pos);
    let rows = entree.1.rows.clone();
    etat.cache.push(entree);
    Some(rows)
}

/// Entrée de moins de 10 min, sans toucher à l'ordre d'usage (`getStorePatch`).
pub fn peek_fresh(key: &str) -> Option<SharedRows> {
    let etat = ETAT.lock();
    etat.cache.iter().find(|(k, e)| k == key && e.created_at.elapsed() < GRID_ROWS_CACHE_TTL).map(|(_, e)| e.rows.clone())
}

/// Calcul en cours pour cette clé.
pub fn pending_get(key: &str) -> Option<RowsFuture> {
    ETAT.lock().pending.get(key).cloned()
}

pub fn pending_contains(key: &str) -> bool {
    ETAT.lock().pending.contains_key(key)
}

pub fn pending_insert(key: &str, fut: RowsFuture) {
    ETAT.lock().pending.insert(key.to_string(), fut);
}

pub fn pending_remove(key: &str) {
    ETAT.lock().pending.remove(key);
}

/// Compteur d'enregistrements de gammes du fournisseur.
pub fn gamme_save_version(code_fournisseur: &str) -> u64 {
    ETAT.lock().gamme_save_version.get(code_fournisseur).copied().unwrap_or(0)
}

/// `invalidateGridRowsCache` : un fournisseur (toutes ses vues magasin), ou tout.
pub fn invalidate_grid_rows_cache(code_fournisseur: Option<&str>) {
    let mut etat = ETAT.lock();
    match code_fournisseur.filter(|c| !c.is_empty()) {
        Some(code) => {
            let p = prefixe(code);
            etat.cache.retain(|(k, _)| !k.starts_with(&p));
            etat.pending.retain(|k, _| !k.starts_with(&p));
        }
        None => {
            etat.cache.clear();
            etat.pending.clear();
        }
    }
}

/// Reporte des gammes enregistrées sur les lignes déjà en cache, au lieu de jeter
/// le cache : l'invalidation forçait un recalcul complet (jusqu'à ~40 s sur un gros
/// fournisseur) à la réouverture suivante. Le résultat est celui qu'aurait donné
/// ce recalcul : la colonne Gamme reprend la valeur du dernier snapshot (Phase 9),
/// la colonne INIT reste l'état serveur.
pub fn patch_grid_rows_cache<'a>(code_fournisseur: &str, changes: impl IntoIterator<Item = (&'a str, &'a str)>) {
    let by_codein: HashMap<&str, GammeCode> = changes.into_iter().map(|(c, g)| (c, g.to_string())).collect();
    if by_codein.is_empty() {
        return;
    }
    let entrees: Vec<SharedRows> = {
        let mut etat = ETAT.lock();
        // Un calcul en cours pour ce fournisseur a lu les gammes avant cet
        // enregistrement : le compteur lui signale de les relire avant d'être caché.
        *etat.gamme_save_version.entry(code_fournisseur.to_string()).or_insert(0) += 1;
        let p = prefixe(code_fournisseur);
        etat.cache.iter().filter(|(k, _)| k.starts_with(&p)).map(|(_, e)| e.rows.clone()).collect()
    };
    for entree in entrees {
        for row in entree.rows.write().iter_mut() {
            if let Some(g) = by_codein.get(row.codein.as_str()) {
                row.code_gamme = Some(g.clone());
            }
        }
    }
}

/// Nombre d'entrées en cache (diagnostic).
pub fn cache_len() -> usize {
    ETAT.lock().cache.len()
}

/// Sérialise les tests qui touchent à l'état global du cache.
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    *ETAT.lock() = Etat::default();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lignes(n: usize) -> SharedRows {
        GridRows::new((0..n).map(|i| ProductRow { codein: format!("C{i}"), ..Default::default() }).collect())
    }

    /// Un seul test : l'état est global au processus.
    #[test]
    fn cache_patch_invalidation_eviction() {
        let _verrou = TEST_LOCK.lock();
        reset_for_tests();
        assert_eq!(grid_rows_cache_key("F1", None), "F1:TOTAL");
        assert_eq!(grid_rows_cache_key("F1", Some("292")), "F1:292");

        let total = lignes(3);
        cache_grid_rows("F1:TOTAL", total.clone());
        cache_grid_rows("F1:292", lignes(3));
        cache_grid_rows("F10:TOTAL", lignes(3));
        assert!(get_fresh("F1:TOTAL").is_some());
        assert!(peek_fresh("absent").is_none());

        // Patch : seules les entrées du fournisseur F1 (pas F10) reçoivent la gamme.
        patch_grid_rows_cache("F1", [("C1", "Z")]);
        assert_eq!(gamme_save_version("F1"), 1);
        assert_eq!(gamme_save_version("F10"), 0);
        assert_eq!(total.rows.read()[1].code_gamme.as_deref(), Some("Z"));
        assert_eq!(get_fresh("F1:292").unwrap().rows.read()[1].code_gamme.as_deref(), Some("Z"));
        assert_eq!(get_fresh("F10:TOTAL").unwrap().rows.read()[1].code_gamme, None);

        // Invalidation d'un fournisseur : « F1: » ne touche pas « F10: ».
        invalidate_grid_rows_cache(Some("F1"));
        assert!(get_fresh("F1:TOTAL").is_none() && get_fresh("F1:292").is_none());
        assert!(get_fresh("F10:TOTAL").is_some());

        // Éviction LRU par nombre de lignes (borne 150 000 par défaut).
        cache_grid_rows("GROS:TOTAL", lignes(150_000));
        assert!(get_fresh("F10:TOTAL").is_none(), "l'entrée la moins récente est évincée");
        assert!(get_fresh("GROS:TOTAL").is_some());
        // Jamais la dernière, même au-delà des bornes.
        cache_grid_rows("ENORME:TOTAL", lignes(150_001));
        assert_eq!(cache_len(), 1);
        invalidate_grid_rows_cache(None);
        assert_eq!(cache_len(), 0);
    }
}
