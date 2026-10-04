/**
 * CollectFlow — Contrôle d'accès commun aux actions serveur, routes et pages.
 *
 * Le jeton de session (JWT) seul ne suffit pas : il reste valide jusqu'à son
 * expiration, même si le compte a été supprimé ou rétrogradé entre-temps. On
 * relit donc l'utilisateur dans la table `users` (avec un cache court), et le
 * rôle enregistré en base l'emporte sur celui du jeton.
 *
 * Base injoignable : on se contente du jeton (mode dégradé), sans quoi le compte
 * de secours `data/users.json` ne pourrait plus rien faire — y compris configurer
 * la base.
 */

import "server-only";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";

export interface UtilisateurCourant {
    id: string;
    username: string;
    role: string;
}

const MESSAGE_SESSION = "Session expirée : reconnectez-vous.";
const MESSAGE_ADMIN = "Action réservée aux administrateurs.";

/** Refus d'accès. `statut` sert aux routes : 401 sans session valide, 403 sans le rôle requis. */
export class AccesRefuse extends Error {
    constructor(message: string, readonly statut: 401 | 403 = 403) {
        super(message);
        this.name = "AccesRefuse";
    }
}

// ── Relecture du compte en base ──────────────────────────────────────────────

/** Durée pendant laquelle une relecture de la table `users` est réutilisée. */
const CACHE_TTL_MS = 60_000;
/** Après un échec de connexion, on ne réessaie pas avant ce délai (chaque essai peut durer 10 s). */
const PAUSE_BASE_INJOIGNABLE_MS = 15_000;

interface FicheUtilisateur {
    exists: boolean;
    role: string;
    username: string;
    at: number;
}

const cache = new Map<string, FicheUtilisateur>();
let baseInjoignableDepuis = 0;

/** Plus grand entier accepté par la colonne `users.id` (serial). */
const ID_MAX = 2_147_483_647;

/**
 * Fiche de l'utilisateur en base, ou `null` si la base n'a pas pu répondre.
 * Un identifiant qui ne peut pas exister (compte de secours « 0 », valeur non
 * numérique) est cherché tel quel : introuvable si la base répond.
 */
async function lireFiche(id: string): Promise<FicheUtilisateur | null> {
    const maintenant = Date.now();
    const enCache = cache.get(id);
    if (enCache && maintenant - enCache.at < CACHE_TTL_MS) return enCache;
    if (maintenant - baseInjoignableDepuis < PAUSE_BASE_INJOIGNABLE_MS) return null;

    const n = /^\d+$/.test(id) ? Number(id) : -1;
    const idNumerique = Number.isSafeInteger(n) && n <= ID_MAX ? n : -1;

    try {
        const [ligne] = await db
            .select({ username: users.username, role: users.role })
            .from(users)
            .where(eq(users.id, idNumerique))
            .limit(1);
        const fiche: FicheUtilisateur = ligne
            ? { exists: true, role: ligne.role, username: ligne.username, at: maintenant }
            : { exists: false, role: "", username: "", at: maintenant };
        cache.set(id, fiche);
        return fiche;
    } catch (e) {
        baseInjoignableDepuis = maintenant;
        console.warn("[authz] Base injoignable, contrôle sur le seul jeton de session :", (e as Error).message?.slice(0, 200));
        return null;
    }
}

// ── Contrôles ────────────────────────────────────────────────────────────────

/** Utilisateur connecté, relu en base. Lève `AccesRefuse` (401) sinon. */
export async function requireSession(): Promise<UtilisateurCourant> {
    const session = await auth();
    const jeton = session?.user as { id?: string | number; name?: string | null; role?: string } | undefined;
    if (!jeton) throw new AccesRefuse(MESSAGE_SESSION, 401);

    const id = jeton.id != null ? String(jeton.id) : "";
    const fiche = await lireFiche(id);

    if (!fiche) {
        // Mode dégradé : le jeton fait foi.
        return { id, username: jeton.name ?? "", role: jeton.role ?? "user" };
    }
    if (!fiche.exists) throw new AccesRefuse(MESSAGE_SESSION, 401);
    return { id, username: fiche.username, role: fiche.role };
}

/** Administrateur connecté. Lève `AccesRefuse` (401 ou 403) sinon. */
export async function requireAdmin(): Promise<UtilisateurCourant> {
    const utilisateur = await requireSession();
    if (utilisateur.role !== "admin") throw new AccesRefuse(MESSAGE_ADMIN, 403);
    return utilisateur;
}

// ── Variantes sans exception ─────────────────────────────────────────────────

export type Autorisation =
    | { ok: true; utilisateur: UtilisateurCourant }
    | { ok: false; message: string; statut: 401 | 403 };

async function verifier(controle: () => Promise<UtilisateurCourant>): Promise<Autorisation> {
    try {
        return { ok: true, utilisateur: await controle() };
    } catch (e) {
        if (e instanceof AccesRefuse) return { ok: false, message: e.message, statut: e.statut };
        throw e;
    }
}

/**
 * Pour les actions qui renvoient un résultat `{ success: false, error }` plutôt
 * que de lever une exception, et pour les pages (le `redirect()` doit être appelé
 * hors d'un try/catch).
 */
export function verifierSession(): Promise<Autorisation> {
    return verifier(requireSession);
}

export function verifierAdmin(): Promise<Autorisation> {
    return verifier(requireAdmin);
}

// ── Variantes pour les routes ────────────────────────────────────────────────

function reponse(a: Autorisation): UtilisateurCourant | Response {
    return a.ok ? a.utilisateur : NextResponse.json({ error: a.message }, { status: a.statut });
}

/**
 * Utilisateur connecté, ou réponse JSON 401 à renvoyer telle quelle :
 *
 *     const acces = await sessionOuReponse();
 *     if (acces instanceof Response) return acces;
 */
export async function sessionOuReponse(): Promise<UtilisateurCourant | Response> {
    return reponse(await verifierSession());
}

/** Administrateur connecté, ou réponse JSON 401 / 403 à renvoyer telle quelle. */
export async function adminOuReponse(): Promise<UtilisateurCourant | Response> {
    return reponse(await verifierAdmin());
}
