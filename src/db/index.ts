import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import fs from "fs";
import path from "path";

let pool: Pool | null = null;
let currentDb: NodePgDatabase<typeof schema> | null = null;

function maskUrl(url: string | undefined) {
    if (!url) return "undefined";
    return url.replace(/:([^@]+)@/, ":****@");
}

/**
 * Initializes or returns the current database instance.
 */
export function getDb() {
    if (currentDb) return currentDb;

    let connectionString = process.env.DATABASE_URL;

    console.log("[DB] Initializing connection...");
    console.log("[DB] Env DATABASE_URL:", maskUrl(process.env.DATABASE_URL));

    try {
        const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
        if (fs.existsSync(CONFIG_PATH)) {
            console.log("[DB] Found config file at:", CONFIG_PATH);
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
            if (config.url) {
                connectionString = config.url;
                console.log("[DB] Using saved database URL:", maskUrl(connectionString));
            }
        } else {
            console.log("[DB] No saved config file found. Using environment variable.");
        }
    } catch (err) {
        console.error("[DB] Error reading config file:", err);
    }

    if (!connectionString) {
        console.error("[DB] CRITICAL: No database connection string available!");
    }

    pool = new Pool({
        connectionString,
    });

    currentDb = drizzle(pool, { schema });
    return currentDb;
}

/**
 * Resets the current database connection. 
 * Called when settings are updated via the UI.
 */
export function refreshDb() {
    console.log("[DB] Refreshing database connection...");
    if (pool) {
        pool.end().catch(err => console.error("[DB] Error closing pool:", err));
        pool = null;
    }
    currentDb = null;
}

/**
 * Proxy for the 'db' instance. 
 * Allows existing imports (import { db } from "@/db") to work 
 * while the underlying instance can be hot-swapped.
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
    get(target, prop, receiver) {
        const d = getDb();
        return Reflect.get(d, prop, receiver);
    }
});
