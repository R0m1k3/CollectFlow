"use server";

import { Pool } from "pg";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, ".db-config.json");

export interface DbConfig {
    url: string;
    openRouterKey?: string;
    openRouterModel?: string;
}

export async function testDatabaseConnection(url: string) {
    console.log("Testing connection to:", url.replace(/:([^@]+)@/, ":****@"));
    const pool = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 5000,
    });

    try {
        const client = await pool.connect();
        await client.query("SELECT 1");
        client.release();
        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Database connection test failed:", errorMessage);
        return { success: false, error: errorMessage };
    } finally {
        await pool.end();
    }
}

export async function saveDatabaseSettings(url: string, openRouterKey?: string, openRouterModel?: string) {
    try {
        const config: DbConfig = { url, openRouterKey, openRouterModel };

        // S'assurer que le dossier data existe
        await fs.mkdir(DATA_DIR, { recursive: true });

        console.log(`[Settings] Saving config to ${CONFIG_FILE}`);
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("[Settings] Database configuration saved successfully.");

        // Refresh the shared DB instance immediately
        const { refreshDb } = await import("@/db");
        refreshDb();

        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save database configuration:", errorMessage);
        return { success: false, error: errorMessage };
    }
}

export async function getSavedDatabaseConfig(): Promise<DbConfig | null> {
    try {
        if (!(await fs.stat(CONFIG_FILE).catch(() => null))) {
            console.log(`[Settings] Config file not found at ${CONFIG_FILE}`);
            return null;
        }
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        const config = JSON.parse(data);
        console.log(`[Settings] Config read from ${CONFIG_FILE}. Key present: ${!!config.openRouterKey}, Model: ${config.openRouterModel || "default"}`);
        return config;
    } catch (error) {
        console.error(`[Settings] Error reading config from ${CONFIG_FILE}:`, error);
        return null;
    }
}
