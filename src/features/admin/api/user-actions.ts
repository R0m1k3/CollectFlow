"use server";

import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/features/auth/logic/auth-logic";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";

/**
 * Vérifie si l'utilisateur actuel est un administrateur.
 */
async function ensureAdmin() {
    const session = await auth();
    if ((session?.user as any)?.role !== "admin") {
        throw new Error("Accès refusé : Droits administrateur requis.");
    }
}

/**
 * Récupère tous les utilisateurs (Admin seulement).
 */
export async function getUsers() {
    await ensureAdmin();
    return db.select({
        id: users.id,
        username: users.username,
        role: users.role,
        createdAt: users.createdAt
    }).from(users);
}

/**
 * Crée un nouvel utilisateur.
 */
export async function createUser(username: string, password: string, role: "admin" | "user" = "user") {
    await ensureAdmin();

    try {
        await db.insert(users).values({
            username,
            passwordHash: hashPassword(password),
            role,
        });
        revalidatePath("/settings");
        return { success: true };
    } catch (err) {
        console.error("CreateUser Error:", err);
        return { success: false, error: "L'utilisateur existe déjà ou une erreur technique est survenue." };
    }
}

/**
 * Supprime un utilisateur.
 */
export async function deleteUser(id: number) {
    await ensureAdmin();

    const session = await auth();
    if (Number((session?.user as any)?.id) === id) {
        return { success: false, error: "Vous ne pouvez pas supprimer votre propre compte." };
    }

    try {
        await db.delete(users).where(eq(users.id, id));
        revalidatePath("/settings");
        return { success: true };
    } catch (err) {
        return { success: false, error: "Erreur lors de la suppression." };
    }
}

/**
 * Met à jour le mot de passe d'un utilisateur.
 */
export async function updatePassword(id: number, newPassword: string) {
    await ensureAdmin();
    try {
        await db.update(users)
            .set({ passwordHash: hashPassword(newPassword) })
            .where(eq(users.id, id));
        return { success: true };
    } catch (err) {
        return { success: false, error: "Erreur lors de la mise à jour du mot de passe." };
    }
}
