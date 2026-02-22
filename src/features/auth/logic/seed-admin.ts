import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "./auth-logic";
import { count } from "drizzle-orm";

/**
 * Checks if the users table is empty.
 * If so, creates a default admin account (admin/admin).
 */
export async function ensureAdminExists() {
    try {
        const [userCount] = await db.select({ value: count() }).from(users);

        if (userCount.value === 0) {
            console.log("BMAD: Initializing default admin account (admin/admin)...");
            await db.insert(users).values({
                username: "admin",
                passwordHash: hashPassword("admin"),
                role: "admin"
            });
            return true;
        }
    } catch (err) {
        // If table doesn't exist, we might need auto-repair like session_snapshots
        // But for users, it's better to let drizzle handled or handle it here if needed.
        console.error("BMAD: Error checking/seeding users table.", err);
    }
    return false;
}
