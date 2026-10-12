/**
 * CollectFlow — Remplaçant de `next/navigation` pour la SPA (React Router).
 *
 * - `useRouter()` : push / replace / back / forward / refresh / prefetch.
 *   `refresh()` relit les données de la page affichée (cf. `lib/page-data`).
 * - `usePathname()`, `useSearchParams()` : suivent aussi les
 *   `history.replaceState` / `pushState` faits directement par l'interface
 *   (changement d'onglet, de magasin…), que Next.js répercutait sur ces hooks
 *   sans recharger la page. React Router, lui, ne les voit pas.
 * - `redirect()`, `notFound()` : pour un composant en cours de rendu.
 */

import { useMemo, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { refreshPage } from "@/lib/page-data";

// ─── Écritures directes dans l'historique ───────────────────────────────────

interface EtatRouteur {
    key: string;
    idx: number;
}

function estEtatRouteur(v: unknown): v is EtatRouteur {
    return !!v && typeof v === "object" && "key" in v && "idx" in v;
}

/** Dernière URL écrite par l'interface, rattachée à l'entrée d'historique du routeur. */
let urlDirecte: { key: string; pathname: string; search: string } | null = null;
let versionDirecte = 0;
const abonnes = new Set<() => void>();

function patcherHistorique(methode: "pushState" | "replaceState"): void {
    const original = window.history[methode];
    window.history[methode] = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
        const precedent = this.state as unknown;
        // React Router écrit un état { usr, key, idx } avec une clé neuve : ce
        // n'est pas une écriture « directe » de l'interface.
        const parRouteur = estEtatRouteur(data) && (!estEtatRouteur(precedent) || data.key !== precedent.key);
        let etat = data;
        if (!parRouteur && data == null && estEtatRouteur(precedent)) {
            // `replaceState(null, …)` effaçait l'index du routeur : on le garde.
            etat = precedent;
        }
        original.call(this, etat, unused, url);
        if (!parRouteur) {
            const cle = estEtatRouteur(etat) ? etat.key : "default";
            urlDirecte = { key: cle, pathname: window.location.pathname, search: window.location.search };
            versionDirecte++;
            abonnes.forEach((f) => f());
        }
    } as History[typeof methode];
}

if (typeof window !== "undefined" && !(window as { __cfHistoryPatched?: boolean }).__cfHistoryPatched) {
    (window as { __cfHistoryPatched?: boolean }).__cfHistoryPatched = true;
    patcherHistorique("pushState");
    patcherHistorique("replaceState");
}

function sAbonner(f: () => void): () => void {
    abonnes.add(f);
    return () => abonnes.delete(f);
}

/** Emplacement affiché : celui du routeur, ou la dernière réécriture directe de cette entrée. */
function useEmplacement(): { pathname: string; search: string } {
    const location = useLocation();
    useSyncExternalStore(sAbonner, () => versionDirecte, () => 0);
    if (urlDirecte && urlDirecte.key === location.key) {
        return { pathname: urlDirecte.pathname, search: urlDirecte.search };
    }
    return { pathname: location.pathname, search: location.search };
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export type ReadonlyURLSearchParams = Omit<URLSearchParams, "append" | "delete" | "set" | "sort">;

export function usePathname(): string {
    return useEmplacement().pathname;
}

export function useSearchParams(): ReadonlyURLSearchParams {
    const { search } = useEmplacement();
    return useMemo(() => new URLSearchParams(search), [search]);
}

export interface NavigateOptions {
    scroll?: boolean;
}

export interface AppRouterInstance {
    push(href: string, options?: NavigateOptions): void;
    replace(href: string, options?: NavigateOptions): void;
    back(): void;
    forward(): void;
    refresh(): void;
    prefetch(href: string): void;
}

export function useRouter(): AppRouterInstance {
    const navigate = useNavigate();
    return useMemo<AppRouterInstance>(
        () => ({
            push: (href, options) => {
                void navigate(href, { preventScrollReset: options?.scroll === false });
            },
            replace: (href, options) => {
                void navigate(href, { replace: true, preventScrollReset: options?.scroll === false });
            },
            back: () => {
                void navigate(-1);
            },
            forward: () => {
                void navigate(1);
            },
            refresh: () => refreshPage(),
            prefetch: () => {},
        }),
        [navigate],
    );
}

// ─── redirect / notFound ────────────────────────────────────────────────────

/** Erreur levée par `notFound()` : la frontière d'erreur affiche « Page introuvable ». */
export class NotFoundError extends Error {
    constructor() {
        super("NEXT_NOT_FOUND");
        this.name = "NotFoundError";
    }
}

export function isNotFoundError(e: unknown): e is NotFoundError {
    return e instanceof NotFoundError;
}

/**
 * Redirection depuis un rendu : remplace l'entrée d'historique puis prévient le
 * routeur (événement `popstate`), et interrompt le rendu en cours.
 */
export function redirect(url: string): never {
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    // Suspend le composant jusqu'au changement de page (jamais résolue).
    throw new Promise<void>(() => {});
}

export function permanentRedirect(url: string): never {
    return redirect(url);
}

export function notFound(): never {
    throw new NotFoundError();
}
