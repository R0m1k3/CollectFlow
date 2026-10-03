import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import fs from "fs";
import path from "path";

/**
 * Pool unique par processus, rangé dans `globalThis` : l'instrumentation (synchro
 * nocturne) et les routes peuvent être compilées dans des lots distincts, chacun
 * avec sa propre copie de ce module — et donc son propre pool de 20 connexions.
 * Même chose à chaque rechargement à chaud en développement.
 */
type DbState = { pool: Pool | null; db: NodePgDatabase<typeof schema> | null };
const globalForDb = globalThis as typeof globalThis & { __collectflowDb?: DbState };
const state: DbState = (globalForDb.__collectflowDb ??= { pool: null, db: null });

export function getPool(): Pool {
    getDb(); // ensure pool is initialized
    return state.pool!;
}

function maskUrl(url: string | undefined) {
    if (!url) return "undefined";
    return url.replace(/:([^@]+)@/, ":****@");
}

/**
 * Initializes or returns the current database instance.
 */
export function getDb() {
    if (state.db) return state.db;

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

    const connectionHostname = connectionString.match(/@([^:/]+)/)?.[1] || "unknown";
    console.log(`[DB] Target Hostname: ${connectionHostname}`);

    // Délai maximal par requête : opt-in (les calculs nocturnes des plus gros
    // fournisseurs peuvent être longs), pour qu'une requête emballée ne monopolise
    // pas indéfiniment une des 20 connexions.
    const statementTimeout = Number(process.env.PG_STATEMENT_TIMEOUT_MS) || undefined;

    const pool = new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        application_name: "collectflow",
        ...(statementTimeout ? { statement_timeout: statementTimeout } : {}),
    });

    pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle client', err);
    });

    // Pas de workers parallèles PostgreSQL : ils consomment /dev/shm, trop petit
    // dans le conteneur, et font échouer les grosses agrégations. Réglé une fois
    // par connexion (la requête est mise en file avant toute autre sur ce client)
    // au lieu d'une transaction BEGIN / SET LOCAL / COMMIT autour de chaque requête.
    pool.on('connect', (client) => {
        client.query("SET max_parallel_workers_per_gather = 0").catch((err) => {
            console.error('[DB] SET max_parallel_workers_per_gather failed:', err?.message);
        });
    });

    state.pool = pool;
    state.db = drizzle(pool, { schema });
    return state.db;
}

/**
 * Resets the current database connection. 
 * Called when settings are updated via the UI.
 */
export function refreshDb() {
    console.log("[DB] Refreshing database connection...");
    if (state.pool) {
        state.pool.end().catch(err => console.error("[DB] Error closing pool:", err));
        state.pool = null;
    }
    state.db = null;
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
