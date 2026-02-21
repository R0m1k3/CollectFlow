import { drizzle as nodeDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import fs from "fs";
import path from "path";

let connectionString = process.env.DATABASE_URL;

// On tente de lire la config sauvegardée via l'UI
try {
    const CONFIG_PATH = path.join(process.cwd(), ".db-config.json");
    if (fs.existsSync(CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        if (config.url) {
            connectionString = config.url;
        }
    }
} catch (err) {
    console.error("Error reading database config file:", err);
}

const pool = new Pool({
    connectionString,
});

export const db = nodeDrizzle(pool, { schema });
