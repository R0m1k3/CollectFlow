"use server";

import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/features/auth/logic/auth-logic";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";

/**
 * Récupère tous les utilisateurs (Admin seulement).
 */
export async function getUsers() {
    await requireAdmin();
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
    await requireAdmin();

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
    const session = await requireAdmin();
    if (Number((session?.user as { id?: string } | undefined)?.id) === id) {
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
    await requireAdmin();
    try {
        await db.update(users)
            .set({ passwordHash: hashPassword(newPassword) })
            .where(eq(users.id, id));
        return { success: true };
    } catch (err) {
        return { success: false, error: "Erreur lors de la mise à jour du mot de passe." };
    }
}
