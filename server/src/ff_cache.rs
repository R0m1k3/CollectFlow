//! Cache mémoire des lectures « FF » (base miroir et API FF Nancy).
//!
//! Les tables FF ne sont recopiées qu'une fois par nuit : recalculer à chaque
//! visite les mêmes agrégations lourdes coûtait plusieurs secondes par page.
//! - durée de vie bornée (`FF_CACHE_TTL_S`, 30 min par défaut) ;
//! - les appels simultanés pour la même clé partagent une seule requête ;
//! - une erreur n'est jamais mise en cache ;
//! - [`invalidate`] vide tout (fin de synchro nocturne).

use futures::future::{BoxFuture, FutureExt, Shared};
use parking_lot::Mutex;
use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 100;

type AnyArc = Arc<dyn Any + Send + Sync>;
type Pending = Shared<BoxFuture<'static, Result<AnyArc, Arc<String>>>>;

enum Entry {
    Ready { value: AnyArc, expires_at: Instant, inserted: u64 },
    Pending(Pending),
}

struct Store {
    map: HashMap<String, Entry>,
    seq: u64,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store { map: HashMap::new(), seq: 0 }));
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn default_ttl() -> Duration {
    let s = std::env::var("FF_CACHE_TTL_S").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).unwrap_or(30 * 60);
    Duration::from_secs(s)
}

/// Options d'une lecture mise en cache.
pub struct CacheOpts<T> {
    /// Durée de vie propre à cette clé.
    pub ttl: Option<Duration>,
    /// Ne garder le résultat que s'il passe ce test (ex. liste non vide : une
    /// lecture qui avale ses erreurs ne doit pas figer une panne passagère).
    pub cache_if: Option<fn(&T) -> bool>,
}

impl<T> Default for CacheOpts<T> {
    fn default() -> Self {
        Self { ttl: None, cache_if: None }
    }
}

/// Lecture mise en cache sous `key`.
pub async fn cached<T, F, Fut>(key: &str, opts: CacheOpts<T>, load: F) -> anyhow::Result<T>
where
    T: Clone + Send + Sync + 'static,
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<T>> + Send + 'static,
{
    let pending = {
        let mut store = STORE.lock();
        match store.map.get(key) {
            Some(Entry::Ready { value, expires_at, .. }) if *expires_at > Instant::now() => {
                if let Some(v) = value.downcast_ref::<T>() {
                    return Ok(v.clone());
                }
                None
            }
            Some(Entry::Pending(p)) => Some(p.clone()),
            _ => None,
        }
    };

    let pending = match pending {
        Some(p) => p,
        None => {
            let generation = GENERATION.load(Ordering::SeqCst);
            let key_owned = key.to_string();
            let ttl = opts.ttl.unwrap_or_else(default_ttl);
            let cache_if = opts.cache_if;
            let fut = load();
            let shared: Pending = async move {
                let res = fut.await;
                let mut store = STORE.lock();
                match res {
                    Ok(value) => {
                        let keep = cache_if.map(|f| f(&value)).unwrap_or(true);
                        let any: AnyArc = Arc::new(value);
                        if generation != GENERATION.load(Ordering::SeqCst) {
                            // Invalidation pendant le chargement : résultat rendu mais pas gardé.
                        } else if keep {
                            store.seq += 1;
                            let inserted = store.seq;
                            store.map.insert(
                                key_owned,
                                Entry::Ready { value: any.clone(), expires_at: Instant::now() + ttl, inserted },
                            );
                            evict(&mut store);
                        } else {
                            store.map.remove(&key_owned);
                        }
                        Ok(any)
                    }
                    Err(e) => {
                        if generation == GENERATION.load(Ordering::SeqCst) {
                            store.map.remove(&key_owned);
                        }
                        Err(Arc::new(format!("{e:#}")))
                    }
                }
            }
            .boxed()
            .shared();
            STORE.lock().map.insert(key.to_string(), Entry::Pending(shared.clone()));
            shared
        }
    };

    match pending.await {
        Ok(any) => any
            .downcast_ref::<T>()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("ff_cache: type inattendu pour la clé {key}")),
        Err(msg) => Err(anyhow::anyhow!("{msg}")),
    }
}

fn evict(store: &mut Store) {
    while store.map.len() > MAX_ENTRIES {
        let oldest = store
            .map
            .iter()
            .filter_map(|(k, e)| match e {
                Entry::Ready { inserted, .. } => Some((k.clone(), *inserted)),
                _ => None,
            })
            .min_by_key(|(_, i)| *i)
            .map(|(k, _)| k);
        match oldest {
            Some(k) => {
                store.map.remove(&k);
            }
            None => break,
        }
    }
}

/// Vide tout le cache FF (fin de synchro nocturne, données fraîches).
pub fn invalidate() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    STORE.lock().map.clear();
}
