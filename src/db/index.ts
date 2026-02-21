import { drizzle as nodeDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import fs from "fs";
import path from "path";

let connectionString = process.env.DATABASE_URL;

function maskUrl(url: string | undefined) {
    if (!url) return "undefined";
    return url.replace(/:([^@]+)@/, ":****@");
}

console.log("[DB] Initial DATABASE_URL (env):", maskUrl(connectionString));

// On tente de lire la config sauvegardée via l'UI
try {
    const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
    if (fs.existsSync(CONFIG_PATH)) {
        console.log("[DB] Found config file at:", CONFIG_PATH);
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        if (config.url) {
            connectionString = config.url;
            console.log("[DB] Using saved database URL:", maskUrl(connectionString));
        } else {
            console.warn("[DB] Config file found but no 'url' key present.");
        }
    } else {
        console.log("[DB] No saved config file found at:", CONFIG_PATH, "(Falling back to env)");
    }
} catch (err) {
    console.error("[DB] Error reading database config file:", err);
}

if (!connectionString) {
    console.error("[DB] CRITICAL: No database connection string available!");
}

const pool = new Pool({
    connectionString,
});

export const db = nodeDrizzle(pool, { schema });
