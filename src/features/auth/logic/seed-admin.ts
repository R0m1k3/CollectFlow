import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "./auth-logic";
import { count, eq, sql } from "drizzle-orm";

/**
 * Checks if the users table is empty.
 * If so, creates a default admin account (admin/admin).
 * Also ensures the table exists (auto-repair).
 */
export async function ensureAdminExists() {
    try {
        console.log("[AUTH] Testing database connection...");
        await db.execute(sql`SELECT 1`);
        console.log("[AUTH] Database connection OK.");

        // 1. Auto-repair: Ensure table exists (Fallback if db-init failed)
        console.log("[AUTH] Checking/Creating users table...");
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS "users" (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'user',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log("[AUTH] users table verified/created.");

        const adminUser = await db.select()
            .from(users)
            .where(eq(users.username, "admin"))
            .limit(1);

        if (adminUser.length === 0) {
            console.log("[AUTH] Admin user not found. Seeding default (admin/admin)...");
            await db.insert(users).values({
                username: "admin",
                passwordHash: hashPassword("admin"),
                role: "admin"
            });
            console.log("[AUTH] Default admin seeded successfully.");
            return true;
        } else {
            console.log("[AUTH] Admin user already exists.");
        }
    } catch (err: any) {
        console.error("[AUTH] !!! CRITICAL DATABASE ERROR !!!");
        console.error("- Message:", err.message);
        console.error("- PG Code:", err.code);
        console.error("- Detail:", err.detail);
        console.error("- Hint:", err.hint);
        if (err.internalQuery) console.error("- Query:", err.internalQuery);
    }
    return false;
}
