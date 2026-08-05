"use server";

/**
 * CollectFlow — Gestion des clés de l'API `/api/v1` (administrateurs).
 *
 * La clé en clair n'existe qu'une fois : elle est renvoyée par `createApiKey()` et
 * jamais restituée ensuite (seul son hachage SHA-256 est stocké). Une clé révoquée
 * conserve sa ligne, pour garder la trace de son usage passé.
 */

import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { generateApiKey } from "@/lib/api-auth";
import { revalidatePath } from "next/cache";

async function ensureAdmin() {
    const session = await auth();
    if ((session?.user as { role?: string } | undefined)?.role !== "admin") {
        throw new Error("Accès refusé : Droits administrateur requis.");
    }
    return session;
}

export interface ApiKeyRow {
    id: number;
    name: string;
    keyPrefix: string;
    role: string;
    createdBy: string | null;
    createdAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

/** Liste les clés. Ne renvoie jamais de secret — seulement le préfixe lisible. */
export async function getApiKeys(): Promise<ApiKeyRow[]> {
    await ensureAdmin();
    const rows = await db
        .select({
            id: apiKeys.id,
            name: apiKeys.name,
            keyPrefix: apiKeys.keyPrefix,
            role: apiKeys.role,
            createdBy: apiKeys.createdBy,
            createdAt: apiKeys.createdAt,
            lastUsedAt: apiKeys.lastUsedAt,
            revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.createdAt));

    return rows.map((r) => ({
        ...r,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    }));
}

/**
 * Crée une clé et renvoie sa valeur **en clair, une seule et unique fois**.
 * L'appelant doit la présenter immédiatement à l'utilisateur : elle est irrécupérable.
 */
export async function createApiKey(
    name: string,
    role: "admin" | "user" = "user",
): Promise<{ success: true; key: string; keyPrefix: string } | { success: false; error: string }> {
    const session = await ensureAdmin();

    const trimmed = name.trim();
    if (!trimmed) return { success: false, error: "Le nom de la clé est obligatoire." };
    if (trimmed.length > 100) return { success: false, error: "Nom trop long (100 caractères max)." };

    try {
        const { key, keyHash, keyPrefix } = generateApiKey();
        await db.insert(apiKeys).values({
            name: trimmed,
            keyPrefix,
            keyHash,
            role,
            createdBy: (session?.user as { name?: string | null } | undefined)?.name ?? null,
        });
        revalidatePath("/settings");
        return { success: true, key, keyPrefix };
    } catch (err) {
        console.error("[api-keys] création KO:", err);
        return { success: false, error: "Erreur technique lors de la création de la clé." };
    }
}

/** Révoque une clé : elle est refusée dès l'appel suivant, mais reste listée. */
export async function revokeApiKey(id: number): Promise<{ success: boolean; error?: string }> {
    await ensureAdmin();
    try {
        await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
        revalidatePath("/settings");
        return { success: true };
    } catch (err) {
        console.error("[api-keys] révocation KO:", err);
        return { success: false, error: "Erreur lors de la révocation." };
    }
}

/** Supprime définitivement une clé révoquée (nettoyage de la liste). */
export async function deleteApiKey(id: number): Promise<{ success: boolean; error?: string }> {
    await ensureAdmin();
    try {
        await db.delete(apiKeys).where(eq(apiKeys.id, id));
        revalidatePath("/settings");
        return { success: true };
    } catch (err) {
        console.error("[api-keys] suppression KO:", err);
        return { success: false, error: "Erreur lors de la suppression." };
    }
}
