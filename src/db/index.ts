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

    let connectionString = "";

    try {
        const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
        if (fs.existsSync(CONFIG_PATH)) {
            console.log("[DB] Found config file at:", CONFIG_PATH);
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
            if (config.url) {
                connectionString = config.url;
                console.log("[DB] Loaded saved database URL from config.");
            }
        }
    } catch (err) {
        console.error("[DB] Error reading config file:", err);
    }

    // Use environment variable as fallback if no config is found
    if (!connectionString && process.env.DATABASE_URL) {
        connectionString = process.env.DATABASE_URL;
        console.log("[DB] Using environment variable as fallback.");
    }

    console.log("[DB] Initializing connection with:", maskUrl(connectionString));

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
