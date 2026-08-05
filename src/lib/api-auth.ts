/**
 * CollectFlow — Authentification de l'API publique `/api/v1`.
 *
 * Deux voies d'entrée :
 *   1. **Clé d'API** (`X-API-Key` ou `Authorization: Bearer …`) — pour les appelants
 *      non-navigateur : scripts, outils externes, assistant IA.
 *   2. **Session NextAuth** — le front de CollectFlow utilise donc les mêmes routes.
 *
 * En cas d'échec on renvoie un **401 JSON**, jamais une redirection : `src/middleware.ts`
 * exempte `/api/v1/*` précisément pour que ce module puisse répondre proprement.
 *
 * Seul le hachage SHA-256 des clés est stocké (table `api_keys`) ; la clé en clair
 * n'existe qu'au moment de sa création.
 */

import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { fail } from "@/lib/api-response";

export interface AuthContext {
    /** Origine de l'authentification — utile pour les logs et l'audit. */
    via: "api_key" | "session";
    role: string;
    /** Nom de la clé, ou identifiant de l'utilisateur connecté. */
    subject: string;
}

/** Préfixe des clés CollectFlow, pour les reconnaître d'un coup d'œil. */
const KEY_PREFIX = "cf_";

export function hashApiKey(key: string): string {
    return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Génère une clé d'API. Renvoie la clé **en clair** (à afficher une seule fois),
 * son hachage à stocker, et un préfixe lisible pour l'identifier dans l'UI.
 */
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
    const secret = randomBytes(24).toString("base64url");
    const key = `${KEY_PREFIX}${secret}`;
    return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 11) };
}

/** Comparaison à temps constant de deux hachages hexadécimaux. */
function hashesEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
}

/** Extrait la clé d'un en-tête `X-API-Key` ou `Authorization: Bearer …`. */
function readKeyFromRequest(req: NextRequest): string | null {
    const direct = req.headers.get("x-api-key");
    if (direct?.trim()) return direct.trim();
    const authz = req.headers.get("authorization");
    if (authz) {
        const m = authz.match(/^Bearer\s+(.+)$/i);
        if (m) return m[1].trim();
    }
    return null;
}

/**
 * Authentifie une requête `/api/v1`.
 *
 * Renvoie un `AuthContext` en cas de succès, ou une réponse d'erreur JSON prête à
 * être retournée par le handler. À appeler en première ligne de chaque endpoint :
 *
 *     const authCtx = await requireApiAuth(req);
 *     if (authCtx instanceof NextResponse) return authCtx;
 */
export async function requireApiAuth(req: NextRequest): Promise<AuthContext | Response> {
    const presented = readKeyFromRequest(req);

    if (presented) {
        const presentedHash = hashApiKey(presented);
        // La colonne key_hash est unique : la recherche par égalité suffit, et la
        // comparaison à temps constant ci-dessous couvre le reste.
        const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, presentedHash)).limit(1);

        if (!row || !hashesEqual(row.keyHash, presentedHash)) {
            return fail("unauthorized", "Clé d'API invalide.");
        }
        if (row.revokedAt) {
            return fail("unauthorized", "Clé d'API révoquée.");
        }

        // Trace d'usage — jamais bloquante pour la requête en cours.
        void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id))
            .catch((e) => console.error("[api-auth] lastUsedAt KO:", (e as Error).message?.slice(0, 120)));

        return { via: "api_key", role: row.role, subject: row.name };
    }

    // Repli sur la session du navigateur (le front utilise les mêmes routes).
    const session = await auth();
    if (session?.user) {
        const user = session.user as { name?: string | null; role?: string };
        return { via: "session", role: user.role ?? "user", subject: user.name ?? "session" };
    }

    return fail(
        "unauthorized",
        "Authentification requise : fournissez un en-tête X-API-Key (ou Authorization: Bearer), ou connectez-vous.",
    );
}

/** Restreint un endpoint aux appelants administrateurs. */
export function requireAdminRole(ctx: AuthContext): Response | null {
    if (ctx.role !== "admin") {
        return fail("forbidden", "Rôle administrateur requis pour cette opération.");
    }
    return null;
}
