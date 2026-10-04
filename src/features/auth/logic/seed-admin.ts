import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, getFallbackUsers, saveFallbackUsers } from "./auth-logic";
import { sql } from "drizzle-orm";

/** Amorçage en cours ou réussi pour ce processus (remis à null en cas d'échec). */
let amorcage: Promise<boolean> | null = null;

/**
 * Prépare les comptes au premier démarrage, une seule fois par processus.
 *
 * - Base joignable : crée la table `users` si besoin (auto-réparation), puis le
 *   compte admin/admin **uniquement si la table est vide**. Un admin supprimé ou
 *   renommé n'est donc pas recréé à chaque connexion. Le fichier de secours
 *   `data/users.json` n'est pas touché.
 * - Base injoignable (première installation, base pas encore configurée) : on
 *   s'assure que le fichier de secours contient un administrateur, et on
 *   retentera la base à la prochaine connexion.
 *
 * Renvoie true si le compte admin/admin vient d'être créé en base.
 */
export function ensureAdminExists(): Promise<boolean> {
    if (!amorcage) {
        amorcage = amorcer().catch((err: unknown) => {
            // Échec : on retentera à la prochaine connexion.
            amorcage = null;
            console.warn("[AUTH] Database seeding failed (expected if DB not configured yet):", (err as Error)?.message ?? err);
            return false;
        });
    }
    return amorcage;
}

async function amorcer(): Promise<boolean> {
    console.log("[AUTH] Testing database connection for seeding...");
    try {
        await db.execute(sql`SELECT 1`);
    } catch (err) {
        assurerAdminDeSecours();
        throw err;
    }

    // Auto-repair: Ensure table exists
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "users" (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    const [{ nb }] = await db.select({ nb: sql<number>`count(*)::int` }).from(users);
    if (nb > 0) return false;

    console.log("[AUTH] Table users vide : création du compte admin/admin.");
    // Si un autre processus l'a créé entre-temps, l'unicité du nom fait échouer
    // l'insertion : on la laisse sans effet plutôt que de relancer l'amorçage.
    const crees = await db.insert(users).values({
        username: "admin",
        passwordHash: hashPassword("admin"),
        role: "admin",
    }).onConflictDoNothing().returning({ id: users.id });
    return crees.length > 0;
}

/** Base injoignable : le fichier de secours doit contenir au moins un administrateur. */
function assurerAdminDeSecours() {
    const fallbackUsers = getFallbackUsers();
    if (fallbackUsers.length === 0) {
        console.log("[AUTH] Initializing local JSON fallback with admin/admin...");
        saveFallbackUsers([{
            id: "0",
            username: "admin",
            passwordHash: hashPassword("admin"),
            role: "admin"
        }]);
    }
}
