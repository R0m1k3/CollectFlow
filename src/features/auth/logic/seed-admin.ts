import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, getFallbackUsers, saveFallbackUsers } from "./auth-logic";
import { count, eq, sql } from "drizzle-orm";

/**
 * Checks if the users table is empty.
 * If so, creates a default admin account (admin/admin).
 * Also ensures the table exists (auto-repair).
 */
export async function ensureAdminExists() {
    // 1. Always ensure local JSON fallback has at least one admin
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

    try {
        console.log("[AUTH] Testing database connection for seeding...");
        await db.execute(sql`SELECT 1`);

        // 2. Auto-repair: Ensure table exists
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS "users" (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'user',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // 3. Sync admin to DB
        const adminUser = await db.select()
            .from(users)
            .where(eq(users.username, "admin"))
            .limit(1);

        if (adminUser.length === 0) {
            console.log("[AUTH] Seeding admin to DB...");
            await db.insert(users).values({
                username: "admin",
                passwordHash: hashPassword("admin"),
                role: "admin"
            });
            return true;
        }
    } catch (err: any) {
        console.warn("[AUTH] Database seeding failed (expected if DB not configured yet):", err.message);
    }
    return false;
}
