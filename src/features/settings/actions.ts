"use server";

import { Pool } from "pg";
import fs from "fs/promises";
import path from "path";

const CONFIG_FILE = path.join(process.cwd(), ".db-config.json");

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
    } catch (error: any) {
        console.error("Database connection test failed:", error.message);
        return { success: false, error: error.message };
    } finally {
        await pool.end();
    }
}

export async function saveDatabaseSettings(url: string) {
    try {
        const config: DbConfig = { url };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log("Database configuration saved to:", CONFIG_FILE);
        return { success: true };
    } catch (error: any) {
        console.error("Failed to save database configuration:", error.message);
        return { success: false, error: error.message };
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
