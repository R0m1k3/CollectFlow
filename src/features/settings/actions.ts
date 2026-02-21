"use server";

import { Pool } from "pg";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, ".db-config.json");

export interface DbConfig {
    url: string;
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

export async function saveDatabaseSettings(url: string) {
    try {
        const config: DbConfig = { url };

        // S'assurer que le dossier data existe
        await fs.mkdir(DATA_DIR, { recursive: true });

        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("Database configuration saved to:", CONFIG_FILE);
        return { success: true };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save database configuration:", errorMessage);
        return { success: false, error: errorMessage };
    }
}

export async function getSavedDatabaseConfig(): Promise<DbConfig | null> {
    try {
        const data = await fs.readFile(CONFIG_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return null;
    }
}
