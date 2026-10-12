/**
 * CollectFlow — Gestion des clés de l'API `/api/v1` (administrateurs).
 *
 * La clé en clair n'existe qu'une fois : elle est renvoyée par `createApiKey()` et
 * jamais restituée ensuite (seul son hachage SHA-256 est stocké). Une clé révoquée
 * conserve sa ligne, pour garder la trace de son usage passé.
 *
 * Actions exécutées par le serveur Rust : `POST /api/actions/{nom}`.
 */

import { callAction } from "@/lib/rpc";

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
    return callAction("getApiKeys", []);
}

/**
 * Crée une clé et renvoie sa valeur **en clair, une seule et unique fois**.
 * L'appelant doit la présenter immédiatement à l'utilisateur : elle est irrécupérable.
 */
export async function createApiKey(
    name: string,
    role: "admin" | "user" = "user",
): Promise<{ success: true; key: string; keyPrefix: string } | { success: false; error: string }> {
    return callAction("createApiKey", [name, role]);
}

/** Révoque une clé : elle est refusée dès l'appel suivant, mais reste listée. */
export async function revokeApiKey(id: number): Promise<{ success: boolean; error?: string }> {
    return callAction("revokeApiKey", [id]);
}

/** Supprime définitivement une clé révoquée (nettoyage de la liste). */
export async function deleteApiKey(id: number): Promise<{ success: boolean; error?: string }> {
    return callAction("deleteApiKey", [id]);
}
