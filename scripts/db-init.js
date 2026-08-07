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

        // Instantané persisté de la grille : lu par /api/v1 pour ne jamais
        // déclencher de recalcul. Rempli en effet de bord par getProductRows().
        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "grid_rows" (
                "code_fournisseur" varchar(20) NOT NULL,
                "codein" varchar(20) NOT NULL,
                "nom_fournisseur" varchar(255),
                "libelle1" varchar(500),
                "gtin" varchar(30),
                "reference" varchar(100),
                "code_centrale" varchar(20),
                "code1" varchar(20),
                "code2" varchar(20),
                "code3" varchar(20),
                "code_gamme" varchar(20),
                "code_gamme_init" varchar(20),
                "total_ca" numeric(16, 2),
                "total_quantite" numeric(14, 2),
                "total_marge" numeric(16, 2),
                "taux_marge" numeric(8, 4),
                "stock_actuel" numeric(14, 2),
                "ca_reseau" numeric(16, 2),
                "qte_reseau" numeric(14, 2),
                "nb_magasins_reseau" integer,
                "ca_par_magasin_reseau" numeric(16, 2),
                "marge_pct_reseau" numeric(8, 4),
                "payload" jsonb NOT NULL,
                "computed_at" timestamp DEFAULT now() NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_grid_rows_fou_codein"
                ON "grid_rows" ("code_fournisseur", "codein");
            CREATE INDEX IF NOT EXISTS "idx_grid_rows_fournisseur" ON "grid_rows" ("code_fournisseur");
            CREATE INDEX IF NOT EXISTS "idx_grid_rows_codein" ON "grid_rows" ("codein");
            CREATE INDEX IF NOT EXISTS "idx_grid_rows_gamme" ON "grid_rows" ("code_gamme");
            CREATE INDEX IF NOT EXISTS "idx_grid_rows_code_centrale" ON "grid_rows" ("code_centrale");
            CREATE INDEX IF NOT EXISTS "idx_grid_rows_total_ca" ON "grid_rows" ("total_ca");
            CREATE INDEX IF NOT EXISTS "idx_grid_rows_libelle" ON "grid_rows" ("libelle1");
        `);
        console.log("[DB Init] Table grid_rows is verified/created.");

        // Clés d'API : seul le hachage SHA-256 est stocké.
        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "api_keys" (
                "id" serial PRIMARY KEY NOT NULL,
                "name" varchar(100) NOT NULL,
                "key_prefix" varchar(20) NOT NULL,
                "key_hash" text NOT NULL UNIQUE,
                "role" varchar(20) DEFAULT 'user' NOT NULL,
                "created_by" varchar(50),
                "created_at" timestamp DEFAULT now(),
                "last_used_at" timestamp,
                "revoked_at" timestamp
            );
        `);
        console.log("[DB Init] Table api_keys is verified/created.");

        // Paramétrage et suivi de la synchronisation nocturne, par fournisseur.
        await tempPool.query(`
            CREATE TABLE IF NOT EXISTS "sync_fournisseurs" (
                "code_fournisseur" varchar(20) PRIMARY KEY NOT NULL,
                "nom_fournisseur" varchar(255),
                "actif_sql" boolean NOT NULL DEFAULT true,
                "actif_qlik" boolean NOT NULL DEFAULT true,
                "desactive_motif" text,
                "dernier_sql_at" timestamp,
                "dernier_sql_statut" varchar(20),
                "dernier_sql_lignes" integer,
                "dernier_sql_erreur" text,
                "dernier_sql_ms" integer,
                "dernier_qlik_at" timestamp,
                "dernier_qlik_statut" varchar(20),
                "dernier_qlik_codes" integer,
                "dernier_qlik_erreur" text,
                "dernier_qlik_ms" integer,
                "updated_at" timestamp DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS "idx_sync_fou_sql" ON "sync_fournisseurs" ("actif_sql", "dernier_sql_at");
            CREATE INDEX IF NOT EXISTS "idx_sync_fou_qlik" ON "sync_fournisseurs" ("actif_qlik", "dernier_qlik_at");
        `);
        console.log("[DB Init] Table sync_fournisseurs is verified/created.");

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
