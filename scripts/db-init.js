import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import fs from "fs";
import path from "path";

async function main() {
    console.log("[DB Init] Starting database migration & initialization...");
    let connectionString = process.env.DATABASE_URL;

    try {
        const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
            if (config.url) {
                connectionString = config.url;
                console.log("[DB Init] Found connection string in data/.db-config.json");
            }
        }
    } catch (e) {
        console.error("[DB Init] Error reading .db-config.json", e);
    }

    if (!connectionString) {
        console.warn("[DB Init] No DATABASE_URL found in env or config. Skipping push.");
        process.exit(0);
    }

    try {
        const tempPool = new Pool({ connectionString, max: 1 });
        const tempDb = drizzle(tempPool, { schema });

        console.log("[DB Init] Connection established. Running migrations...");

        // Note: For Drizzle without pre-generated SQL migrations (using drizzle-kit push in dev), 
        // running migrations programmatically requires the generated sql files.
        // Since we want to auto-create tables without requiring dev dependencies in production, 
        // we will create the specific missing table `ai_supplier_context` directly if it doesn't exist to ensure the app works.
        // A full robust migration system would use `npx drizzle-kit push` but that is not available in the standalone build easily.

        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "ai_supplier_context" (
                "code_fournisseur" varchar(20) PRIMARY KEY NOT NULL,
                "context" text NOT NULL,
                "updated_at" timestamp DEFAULT now()
            );
        `);
        console.log("[DB Init] Table ai_supplier_context is verified/created.");


        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "session_snapshots" (
                "id" serial PRIMARY KEY NOT NULL,
                "user_id" integer,
                "code_fournisseur" varchar(20) NOT NULL,
                "nom_fournisseur" varchar(255),
                "magasin" varchar(20) NOT NULL,
                "changes" jsonb NOT NULL,
                "summary_json" jsonb,
                "label" text,
                "type" varchar(20) DEFAULT 'snapshot',
                "created_at" timestamp DEFAULT now()
            );
        `);
        console.log("[DB Init] Table session_snapshots is verified/created.");

        await tempPool.end();
        console.log("[DB Init] Initialization successful. Exiting.");
        process.exit(0);
    } catch (error) {
        console.error("[DB Init] Initialization failed:", error);
        // Do not crash the app, just let it run (it uses fallback JSON anyway)
        process.exit(0);
    }
}

main();
