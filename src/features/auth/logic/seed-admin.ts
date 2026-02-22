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
        // 1. Auto-repair: Ensure table exists
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'user',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // 2. Check if admin specifically exists
        const adminUser = await db.select()
            .from(users)
            .where(eq(users.username, "admin"))
            .limit(1);

        if (adminUser.length === 0) {
            console.log("BMAD: Default admin account not found. Initializing (admin/admin)...");
            await db.insert(users).values({
                username: "admin",
                passwordHash: hashPassword("admin"),
                role: "admin"
            });
            return true;
        }
    } catch (err) {
        console.error("BMAD: CRITICAL Error checking/seeding users table.", err);
    }
    return false;
}
