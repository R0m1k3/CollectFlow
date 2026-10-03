/**
 * CollectFlow — Cache mémoire des lectures « FF » (base miroir et API FF Nancy).
 *
 * Les tables FF (`mvtart`, `cube_stock`, `articles`…) ne sont recopiées qu'une
 * fois par nuit depuis SQL Server : recalculer à chaque visite les mêmes
 * agrégations lourdes (stock, hit-parade, CA mensuel…) coûtait plusieurs
 * secondes par page pour un résultat identique.
 *
 * Pourquoi pas `unstable_cache` : il sérialise en JSON (une `Map` devient `{}`,
 * une `Date` une chaîne) et ne peut pas être invalidé hors d'une requête — or
 * c'est la synchro nocturne, lancée par un minuteur, qui sait quand les données
 * changent. Ici :
 * - une durée de vie bornée (FF_CACHE_TTL_S, 30 min par défaut) ;
 * - les appels simultanés pour la même clé partagent une seule requête ;
 * - une erreur n'est jamais mise en cache ;
 * - `invalidateFFCache()` vide tout (appelé en fin de synchro nocturne).
 */

import "server-only";

import { pgGetDerniereReceptionParFournisseur, pgGetFournisseurs } from "@/lib/pg-ff-client";

const TTL_MS = (Number(process.env.FF_CACHE_TTL_S) || 30 * 60) * 1000;
/** Plafond d'entrées : les clés incluent des paramètres (dates, mois, magasin). */
const MAX_ENTRIES = 100;

interface Entry {
    value?: unknown;
    expiresAt: number;
    pending?: Promise<unknown>;
}

// Rangé dans globalThis : un seul cache par processus, même si ce module est
// présent dans plusieurs lots compilés (routes, instrumentation).
const globalForFFCache = globalThis as typeof globalThis & {
    __collectflowFFCache?: { store: Map<string, Entry>; generation: number };
};
const cache = (globalForFFCache.__collectflowFFCache ??= { store: new Map(), generation: 0 });
const store = cache.store;

interface CachedOptions<T> {
    /** Durée de vie propre à cette clé, en millisecondes. */
    ttlMs?: number;
    /**
     * Ne garder le résultat que s'il passe ce test. Sert aux lectures qui
     * avalent leurs erreurs et renvoient une liste vide : sans ce garde-fou,
     * une panne passagère resterait affichée pendant toute la durée de vie.
     */
    cacheIf?: (value: T) => boolean;
}

export async function cachedFF<T>(key: string, load: () => Promise<T>, options: CachedOptions<T> = {}): Promise<T> {
    const now = Date.now();
    const entry = store.get(key);
    if (entry && "value" in entry && entry.expiresAt > now) return entry.value as T;
    if (entry?.pending) return entry.pending as Promise<T>;

    // Une invalidation pendant le chargement rend son résultat suspect : il est
    // alors renvoyé à l'appelant, mais pas conservé.
    const generation = cache.generation;
    const pending = load().then(
        (value) => {
            if (generation !== cache.generation) return value;
            if (options.cacheIf && !options.cacheIf(value)) {
                store.delete(key);
            } else {
                store.delete(key); // réinsertion en fin : ordre d'éviction = ancienneté
                store.set(key, { value, expiresAt: Date.now() + (options.ttlMs ?? TTL_MS) });
                while (store.size > MAX_ENTRIES) {
                    const oldest = store.keys().next().value;
                    if (oldest === undefined) break;
                    store.delete(oldest);
                }
            }
            return value;
        },
        (error) => {
            if (generation === cache.generation) store.delete(key);
            throw error;
        },
    );
    // Une éventuelle valeur expirée est remplacée : seule la requête en cours compte.
    store.set(key, { expiresAt: 0, pending });
    return pending;
}

/** Vide tout le cache FF (fin de synchro nocturne, données fraîches). */
export function invalidateFFCache(): void {
    cache.generation++;
    store.clear();
}

// ---------------------------------------------------------------------------
// Lectures partagées par plusieurs pages
// ---------------------------------------------------------------------------

/** Référentiel fournisseurs (Grille, cadencier). Vide = erreur avalée, non gardé. */
export function getFournisseursCached(): Promise<{ code: string; nom: string }[]> {
    return cachedFF("fournisseurs", () => pgGetFournisseurs(), { cacheIf: (rows) => rows.length > 0 });
}

/**
 * Dernière réception par fournisseur et magasin (cadencier). Agrège tout
 * l'historique de `mvtart` : de loin la lecture la plus lourde de la page
 * Commandes. Vide = erreur avalée, non gardé.
 */
export function getDerniereReceptionCached(): Promise<Map<string, string>> {
    return cachedFF("derniere-reception", () => pgGetDerniereReceptionParFournisseur(), {
        cacheIf: (map) => map.size > 0,
    });
}
