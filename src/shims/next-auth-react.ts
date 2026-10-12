/**
 * CollectFlow — Remplaçant de `next-auth/react` pour la SPA.
 *
 * La session est tenue par le serveur Rust (cookie HTTP-only) ; l'interface la
 * lit sur `GET /api/auth/session` et se déconnecte par `POST /api/auth/logout`.
 * Mêmes exports que ceux utilisés de next-auth : `SessionProvider`,
 * `useSession`, `signOut`.
 */

import { createContext, createElement, startTransition, use, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRefreshVersion } from "@/lib/page-data";

export interface SessionUser {
    id: string;
    name: string;
    role: string;
}

export interface Session {
    user: SessionUser;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface SessionContextValue {
    data: Session | null;
    status: SessionStatus;
    /** Promesse de la session courante (pour suspendre une page en attendant). */
    promise: Promise<Session | null>;
    update: () => Promise<Session | null>;
}

/**
 * Lit la session sur le serveur. Serveur injoignable ou réponse illisible : la
 * session connue est conservée (une coupure réseau ne déconnecte pas).
 */
async function lireSession(connue: Session | null = null): Promise<Session | null> {
    try {
        const res = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return connue;
        const body = (await res.json()) as { user?: SessionUser | null };
        return body?.user ? { user: body.user } : null;
    } catch {
        return connue;
    }
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Dernière session lue (une seule application par onglet). */
let sessionConnue: Session | null = null;

/**
 * Charge la session au démarrage, puis la relit à chaque `router.refresh()`
 * (sans repasser par l'état « loading » : l'interface ne clignote pas).
 */
export function SessionProvider({ children }: { children: ReactNode; refetchOnWindowFocus?: boolean }) {
    const [promise, setPromise] = useState<Promise<Session | null>>(() => lireSession());
    const [etat, setEtat] = useState<{ data: Session | null; status: SessionStatus }>({ data: null, status: "loading" });
    const version = useRefreshVersion();
    const premiere = useRef(true);

    useEffect(() => {
        let actif = true;
        promise.then((s) => {
            sessionConnue = s;
            if (actif) setEtat({ data: s, status: s ? "authenticated" : "unauthenticated" });
        });
        return () => {
            actif = false;
        };
    }, [promise]);

    useEffect(() => {
        if (premiere.current) {
            premiere.current = false;
            return;
        }
        // Rafraîchissement de la page : la session (rôle relu en base) aussi, en
        // transition pour qu'une page qui l'attend reste affichée.
        const p = lireSession(sessionConnue);
        startTransition(() => setPromise(p));
    }, [version]);

    const update = useCallback(() => {
        const p = lireSession(sessionConnue);
        startTransition(() => setPromise(p));
        return p;
    }, []);

    const value = useMemo<SessionContextValue>(() => ({ ...etat, promise, update }), [etat, promise, update]);
    return createElement(SessionContext, { value }, children);
}

/** Session courante, comme `useSession()` de next-auth. */
export function useSession(): Pick<SessionContextValue, "data" | "status" | "update"> {
    const ctx = useContext(SessionContext);
    if (!ctx) throw new Error("useSession doit être utilisé dans <SessionProvider>.");
    return { data: ctx.data, status: ctx.status, update: ctx.update };
}

/**
 * Session déjà chargée : suspend la page tant qu'elle ne l'est pas (les pages
 * serveur la connaissaient avant leur rendu).
 */
export function useSessionResolue(): Session | null {
    const ctx = useContext(SessionContext);
    if (!ctx) throw new Error("useSessionResolue doit être utilisé dans <SessionProvider>.");
    return use(ctx.promise);
}

/** Déconnexion : supprime le cookie de session puis, sauf `redirect: false`, va à la connexion. */
export async function signOut(options: { redirect?: boolean; callbackUrl?: string } = {}): Promise<void> {
    try {
        const res = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
        await res.text();
    } catch {
        /* le cookie expirera de lui-même ; on quitte quand même l'application */
    }
    if (options.redirect !== false) {
        window.location.assign(options.callbackUrl ?? "/login");
    }
}
