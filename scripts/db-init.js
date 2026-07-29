const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const cwd = path.resolve(__dirname, '..'); // get app root when inside /scripts

async function main() {
    console.log("[DB Init] Starting database migration & initialization...");
    let connectionString = "";

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

    // Use environment variable as default IF NOT already loaded from config
    if (!connectionString && process.env.DATABASE_URL) {
        connectionString = process.env.DATABASE_URL;
        console.log("[DB Init] Using environment variable DATABASE_URL as fallback.");
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

        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "users" (
                "id" serial PRIMARY KEY NOT NULL,
                "username" varchar(50) NOT NULL UNIQUE,
                "password_hash" text NOT NULL,
                "role" varchar(20) NOT NULL DEFAULT 'user',
                "created_at" timestamp DEFAULT now()
            );
        `);
        console.log("[DB Init] Table users is verified/created.");

        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "commande_cadences" (
                "id" serial PRIMARY KEY NOT NULL,
                "code_fournisseur" varchar(20) NOT NULL,
                "nom_fournisseur" varchar(255),
                "site" varchar(20) NOT NULL,
                "intervalle_semaines" integer NOT NULL,
                "actif" boolean NOT NULL DEFAULT true,
                "created_at" timestamp DEFAULT now(),
                "updated_at" timestamp DEFAULT now()
            );
        `);
        await tempPool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_cadence_fou_site"
                ON "commande_cadences" ("code_fournisseur", "site");
        `);
        await tempPool.query(`
            CREATE INDEX IF NOT EXISTS "idx_cadence_site"
                ON "commande_cadences" ("site");
        `);
        console.log("[DB Init] Table commande_cadences is verified/created.");

        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "qlik_network_metrics" (
                "code_centrale" varchar(20) PRIMARY KEY NOT NULL,
                "ca_reseau" numeric(16, 2),
                "qte_reseau" numeric(14, 2),
                "nb_magasins_reseau" integer,
                "ca_par_magasin_reseau" numeric(16, 2),
                "marge_pct_reseau" numeric(8, 4),
                "periode" varchar(20),
                "fetched_at" timestamp DEFAULT now()
            );
        `);
        // Colonnes ajoutées après coup (DB existante) — CREATE IF NOT EXISTS ne les pose pas.
        await tempPool.query(`
            ALTER TABLE "qlik_network_metrics"
                ADD COLUMN IF NOT EXISTS "ca_par_magasin_reseau" numeric(16, 2),
                ADD COLUMN IF NOT EXISTS "marge_pct_reseau" numeric(8, 4),
                ADD COLUMN IF NOT EXISTS "qte_by_month" jsonb,
                ADD COLUMN IF NOT EXISTS "metrics_by_month" jsonb,
                ADD COLUMN IF NOT EXISTS "libelle_reseau" varchar(255),
                ADD COLUMN IF NOT EXISTS "fournisseur_reseau" varchar(255);
            ALTER TABLE "qlik_network_metrics" DROP COLUMN IF EXISTS "rupture_pct_reseau";
            ALTER TABLE "qlik_network_metrics" DROP COLUMN IF EXISTS "couverture_stock_reseau";
        `);
        console.log("[DB Init] Table qlik_network_metrics is verified/created.");

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
