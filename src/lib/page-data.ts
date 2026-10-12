/**
 * CollectFlow — Données des pages côté navigateur.
 *
 * Les pages Next.js étaient des composants serveur : leurs données arrivaient
 * avec le rendu, `loading.tsx` s'affichait pendant le premier chargement et une
 * navigation (changement de paramètres, `router.refresh()`) gardait la page à
 * l'écran jusqu'à l'arrivée des nouvelles données.
 *
 * Même fonctionnement ici, avec Suspense : `usePageData` suspend la page sur la
 * promesse de ses données. Au premier affichage, la frontière Suspense de la
 * route montre la silhouette (`loading.tsx`) ; lors d'une navigation ou d'un
 * rafraîchissement — toujours faits en transition — l'ancienne page reste
 * affichée jusqu'à la réponse.
 *
 * Les données sont relues à chaque navigation (clé d'historique de React
 * Router) et à chaque `router.refresh()` (compteur de rafraîchissement), mais
 * pas quand l'interface réécrit seulement l'URL (`history.replaceState`, ex.
 * changement d'onglet) : comme avec Next.js.
 */

import { createElement, createContext, startTransition, use, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

// ─── Rafraîchissement (router.refresh) ──────────────────────────────────────

const RefreshContext = createContext(0);

let incrementer: (() => void) | null = null;

/** Fournit le compteur de rafraîchissement dont dépendent les données des pages. */
export function RefreshProvider({ children }: { children: ReactNode }) {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        incrementer = () => setVersion((v) => v + 1);
        return () => {
            incrementer = null;
        };
    }, []);
    return createElement(RefreshContext, { value: version }, children);
}

/** Numéro de rafraîchissement courant. */
export function useRefreshVersion(): number {
    return useContext(RefreshContext);
}

/**
 * Relit les données de la page affichée (équivalent de `router.refresh()`).
 * Par défaut en transition : la page reste visible pendant le chargement.
 */
export function refreshPage({ transition = true }: { transition?: boolean } = {}): void {
    if (!incrementer) return;
    if (transition) startTransition(() => incrementer?.());
    else incrementer();
}

// ─── Cache des promesses ────────────────────────────────────────────────────

const MAX_ENTREES = 40;
const cache = new Map<string, Promise<unknown>>();

function memo<T>(cle: string, charger: () => Promise<T>): Promise<T> {
    let p = cache.get(cle) as Promise<T> | undefined;
    if (!p) {
        p = charger();
        // Évite un rejet « non géré » dans la console : l'erreur est relevée par `use`.
        p.catch(() => {});
        cache.set(cle, p);
        while (cache.size > MAX_ENTREES) {
            const plusAncienne = cache.keys().next().value;
            if (plusAncienne === undefined) break;
            cache.delete(plusAncienne);
        }
    }
    return p;
}

/**
 * Clé de rendu de la page courante : change à chaque navigation (nouvelle
 * entrée d'historique) et à chaque rafraîchissement, pas sur un simple
 * `history.replaceState` de l'interface.
 */
export function usePageKey(): string {
    const { key } = useLocation();
    const version = useRefreshVersion();
    return `${key}#${version}`;
}

/**
 * Données d'une page : suspend jusqu'à leur arrivée. Une erreur est relevée et
 * remonte à la frontière d'erreur (`error.tsx`), comme l'exception d'une page
 * serveur.
 */
export function usePageData<T>(nom: string, charger: () => Promise<T>): T {
    const cle = `${nom}@${usePageKey()}`;
    return use(memo(cle, charger));
}

export type Resultat<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Comme `usePageData`, mais l'erreur est rendue sous forme de résultat : pour
 * les pages qui affichaient un `ErrorState` avec le message de l'exception.
 */
export function usePageResult<T>(nom: string, charger: () => Promise<T>): Resultat<T> {
    return usePageData<Resultat<T>>(`${nom}:resultat`, () =>
        charger().then(
            (data) => ({ ok: true as const, data }),
            (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        ),
    );
}

/**
 * Paramètres d'URL de la page, comme le `searchParams` d'une page serveur
 * (première valeur de chaque clé). Ceux du routeur : une réécriture directe de
 * l'URL par l'interface ne les change pas, comme avec Next.js.
 */
export function usePageSearchParams(): Record<string, string> {
    const { search } = useLocation();
    return useMemo(() => {
        const o: Record<string, string> = {};
        new URLSearchParams(search).forEach((v, k) => {
            if (!(k in o)) o[k] = v;
        });
        return o;
    }, [search]);
}
