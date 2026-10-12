/**
 * Gestion des comptes (administrateurs) — actions exécutées par le serveur
 * Rust : `POST /api/actions/{nom}`.
 */

import { callAction } from "@/lib/rpc";

export interface UtilisateurListe {
    id: number;
    username: string;
    role: string;
    /** Date ISO de création. */
    createdAt: string | null;
}

/**
 * Récupère tous les utilisateurs (Admin seulement).
 */
export async function getUsers(): Promise<UtilisateurListe[]> {
    return callAction("getUsers", []);
}

/**
 * Crée un nouvel utilisateur.
 */
export async function createUser(
    username: string,
    password: string,
    role: "admin" | "user" = "user",
): Promise<{ success: boolean; error?: string }> {
    return callAction("createUser", [username, password, role]);
}

/**
 * Supprime un utilisateur.
 */
export async function deleteUser(id: number): Promise<{ success: boolean; error?: string }> {
    return callAction("deleteUser", [id]);
}

/**
 * Met à jour le mot de passe d'un utilisateur.
 */
export async function updatePassword(id: number, newPassword: string): Promise<{ success: boolean; error?: string }> {
    return callAction("updatePassword", [id, newPassword]);
}
