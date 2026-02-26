const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const cwd = path.resolve(__dirname, '..'); // get app root when inside /scripts

async function main() {
    console.log("[DB Init] Starting database migration & initialization...");
    let connectionString = process.env.DATABASE_URL;

    try {
        const CONFIG_PATH = path.join(cwd, "data", ".db-config.json");
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

        console.log("[DB Init] Connection established. Running migrations via raw SQL...");

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
