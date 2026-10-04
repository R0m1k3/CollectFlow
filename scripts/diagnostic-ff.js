/**
 * CollectFlow — Diagnostic des requêtes sur la base FF (lecture seule).
 *
 * Sert à préparer l'optimisation des requêtes lentes (Meilleures ventes, fiche
 * produit, stocks, commandes) : le schéma et les index des tables FF ne sont pas
 * dans le dépôt, il faut donc les relever sur la vraie base avant de réécrire
 * quoi que ce soit.
 *
 * Usage (sur le serveur, ou dans le conteneur Docker de l'application) :
 *
 *     node scripts/diagnostic-ff.js > diagnostic-ff.txt
 *     node scripts/diagnostic-ff.js --analyze > diagnostic-ff.txt
 *
 * Sans option, rien n'est exécuté : seuls les plans prévus (EXPLAIN) sont lus.
 * `--analyze` exécute réellement les requêtes analysées pour mesurer leur durée
 * (EXPLAIN ANALYZE) : à lancer de préférence en dehors des heures d'ouverture.
 * La session est en lecture seule et chaque requête est coupée au-delà de 2 min.
 *
 * Connexion : `data/.db-config.json` (réglée dans Paramètres), sinon DATABASE_URL.
 */
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const ANALYZE = process.argv.includes("--analyze");
const TABLES = ["articles", "mvtart", "cube_stock", "artfou1", "fouident", "nomenclature", "grid_rows", "session_snapshots"];
const COLONNES = {
    articles: ["no_id", "codein", "artcentrale", "nom_no_id", "libelle1"],
    mvtart: ["no_id", "artnoid", "site", "datmvt", "genremvt"],
    cube_stock: ["artnoid", "site", "qte"],
    artfou1: ["no_id", "art_no_id", "code", "preference"],
    fouident: ["code"],
};

function connexion() {
    try {
        const fichier = path.join(path.resolve(__dirname, ".."), "data", ".db-config.json");
        if (fs.existsSync(fichier)) {
            const config = JSON.parse(fs.readFileSync(fichier, "utf-8"));
            if (config.url) return config.url;
        }
    } catch {
        /* configuration illisible : on tente la variable d'environnement */
    }
    return process.env.DATABASE_URL || "";
}

function titre(texte) {
    console.log(`\n${"=".repeat(78)}\n${texte}\n${"=".repeat(78)}`);
}

async function section(nom, fn) {
    titre(nom);
    const debut = Date.now();
    try {
        await fn();
    } catch (e) {
        console.log(`  (indisponible : ${e.message})`);
    }
    console.log(`  [${Date.now() - debut} ms]`);
}

async function plan(client, nom, requete, params = []) {
    await section(`PLAN — ${nom}`, async () => {
        const options = ANALYZE ? "ANALYZE, BUFFERS, FORMAT TEXT" : "FORMAT TEXT";
        const { rows } = await client.query(`EXPLAIN (${options}) ${requete}`, params);
        for (const r of rows) console.log(`  ${r["QUERY PLAN"]}`);
    });
}

// Requêtes reprises de src/lib/pg-ff-client.ts (même forme, paramètres d'exemple).
const HIT_PARADE = `
WITH ventes AS (
    SELECT TRIM(a.codein::text) AS codein, m.site,
           SUM(-m.qtemvt)::float AS qte_vendue, SUM(-m.mntmvtttc)::float AS ca_ttc, SUM(m.margemvt)::float AS marge
    FROM mvtart m JOIN articles a ON a.no_id = m.artnoid
    WHERE m.datmvt BETWEEN $1::date AND $2::date AND m.site IN ('292', '579') AND m.genremvt = 3 AND a.codein IS NOT NULL
    GROUP BY TRIM(a.codein::text), m.site
),
attrs AS (
    SELECT DISTINCT ON (TRIM(a.codein::text)) TRIM(a.codein::text) AS codein, a.libelle1::text AS libelle,
           COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur
    FROM articles a
    LEFT JOIN LATERAL (SELECT af1.code FROM artfou1 af1 WHERE af1.art_no_id = a.no_id AND af1.preference = 1 ORDER BY af1.code LIMIT 1) af ON TRUE
    LEFT JOIN fouident fi ON fi.code = af.code
    WHERE TRIM(a.codein::text) IN (SELECT codein FROM ventes)
    ORDER BY TRIM(a.codein::text), a.no_id DESC
),
stock_agg AS (
    SELECT TRIM(a2.codein::text) AS codein, SUM(cs.qte)::float AS stock_total
    FROM cube_stock cs JOIN articles a2 ON a2.no_id = cs.artnoid
    WHERE TRIM(a2.codein::text) IN (SELECT codein FROM ventes)
    GROUP BY TRIM(a2.codein::text)
)
SELECT v.*, ar.libelle, ar.fournisseur, s.stock_total
FROM ventes v LEFT JOIN attrs ar ON ar.codein = v.codein LEFT JOIN stock_agg s ON s.codein = v.codein
ORDER BY v.ca_ttc DESC`;

const DERNIERE_RECEPTION = `
SELECT af.code AS codefou, m.site, MAX(m.datmvt) AS derniere
FROM mvtart m
JOIN articles a ON a.no_id = m.artnoid
JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
WHERE m.genremvt IN (1, 2) AND m.site IN ('292', '579') AND m.datmvt IS NOT NULL
GROUP BY af.code, m.site`;

const MENSUEL_FOURNISSEUR = `
SELECT a.codein, m.site, TO_CHAR(m.datmvt, 'YYYY-MM') AS mois, SUM(m.qtemvt)
FROM mvtart m
JOIN articles a ON a.no_id = m.artnoid
JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = $1) af ON af.art_no_id = a.no_id
WHERE m.datmvt BETWEEN $2::date AND $3::date AND m.site IN ('292', '579')
GROUP BY a.codein, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')`;

const STOCK_SANS_VENTE = `
SELECT a.codein, m.site, MAX(m.datmvt)
FROM mvtart m
JOIN articles a ON a.no_id = m.artnoid
LEFT JOIN cube_stock cs ON cs.artnoid = a.no_id AND cs.site = m.site
WHERE m.genremvt IN (1, 2) AND m.site IN ('292', '579') AND m.datmvt < date_trunc('month', CURRENT_DATE)
  AND NOT EXISTS (SELECT 1 FROM mvtart mv2 WHERE mv2.artnoid = m.artnoid AND mv2.site = m.site AND mv2.genremvt = 3)
GROUP BY a.codein, m.site, cs.qte
HAVING COALESCE(cs.qte::float, 0) <> 0`;

async function main() {
    const url = connexion();
    if (!url) {
        console.error("Aucune connexion : ni data/.db-config.json ni DATABASE_URL.");
        process.exit(1);
    }
    const pool = new Pool({ connectionString: url, max: 1, application_name: "collectflow-diagnostic" });
    const client = await pool.connect();
    try {
        await client.query("SET default_transaction_read_only = on");
        await client.query("SET statement_timeout = '120s'");
        await client.query("SET max_parallel_workers_per_gather = 0"); // comme l'application

        console.log(`Diagnostic FF — ${new Date().toISOString()} — mode ${ANALYZE ? "EXPLAIN ANALYZE (requêtes exécutées)" : "EXPLAIN (plans seuls)"}`);

        await section("Serveur PostgreSQL et réglages", async () => {
            const { rows } = await client.query(`
                SELECT name, setting, unit FROM pg_settings
                WHERE name IN ('server_version', 'work_mem', 'shared_buffers', 'effective_cache_size',
                               'random_page_cost', 'max_parallel_workers_per_gather', 'default_statistics_target')
                ORDER BY name`);
            for (const r of rows) console.log(`  ${r.name.padEnd(32)} ${r.setting}${r.unit ? ` ${r.unit}` : ""}`);
        });

        await section("Taille des tables (lignes estimées, taille totale avec index)", async () => {
            const { rows } = await client.query(`
                SELECT c.relname, c.reltuples::bigint AS lignes, pg_size_pretty(pg_total_relation_size(c.oid)) AS taille,
                       s.last_analyze, s.last_autoanalyze
                FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
                WHERE c.relkind IN ('r', 'p', 'm', 'v') AND c.relname = ANY($1)
                ORDER BY c.relname`, [TABLES]);
            const trouvees = new Set(rows.map((r) => r.relname));
            for (const r of rows) {
                const analyse = r.last_analyze || r.last_autoanalyze;
                console.log(`  ${r.relname.padEnd(20)} ${String(r.lignes).padStart(12)} lignes  ${String(r.taille).padStart(10)}  dernière analyse : ${analyse ? new Date(analyse).toISOString() : "jamais"}`);
            }
            for (const t of TABLES) if (!trouvees.has(t)) console.log(`  ${t.padEnd(20)} (absente)`);
        });

        await section("Types des colonnes utilisées dans les jointures et filtres", async () => {
            for (const [table, colonnes] of Object.entries(COLONNES)) {
                const { rows } = await client.query(`
                    SELECT column_name, data_type, character_maximum_length, table_schema
                    FROM information_schema.columns WHERE table_name = $1 AND column_name = ANY($2)
                    ORDER BY column_name`, [table, colonnes]);
                for (const r of rows) {
                    console.log(`  ${`${r.table_schema}.${table}.${r.column_name}`.padEnd(36)} ${r.data_type}${r.character_maximum_length ? `(${r.character_maximum_length})` : ""}`);
                }
            }
        });

        await section("Index existants", async () => {
            const { rows } = await client.query(`
                SELECT tablename, indexname, indexdef FROM pg_indexes
                WHERE tablename = ANY($1) ORDER BY tablename, indexname`, [TABLES]);
            for (const r of rows) console.log(`  ${r.tablename.padEnd(18)} ${r.indexdef}`);
            if (rows.length === 0) console.log("  (aucun index trouvé sur ces tables)");
        });

        await section("Codes article avec espaces (rend TRIM() nécessaire ou non)", async () => {
            const { rows } = await client.query(`
                SELECT count(*) AS total,
                       count(*) FILTER (WHERE codein::text <> TRIM(codein::text)) AS avec_espaces,
                       count(DISTINCT TRIM(codein::text)) AS distincts
                FROM articles`);
            const r = rows[0];
            console.log(`  codein : ${r.total} articles — ${r.avec_espaces} avec espaces — ${r.distincts} codes distincts`);
            try {
                const { rows: c } = await client.query(`
                    SELECT count(*) FILTER (WHERE artcentrale::text <> TRIM(artcentrale::text)) AS avec_espaces
                    FROM articles WHERE artcentrale IS NOT NULL`);
                console.log(`  artcentrale : ${c[0].avec_espaces} avec espaces`);
            } catch (e) {
                console.log(`  artcentrale : (indisponible : ${e.message})`);
            }
        });

        // Paramètres d'exemple tirés de la base elle-même.
        let codein = null;
        let codefou = null;
        try {
            codein = (await client.query("SELECT TRIM(codein::text) AS c FROM articles WHERE codein IS NOT NULL LIMIT 1")).rows[0]?.c ?? null;
            codefou = (await client.query("SELECT code FROM artfou1 WHERE preference = 1 GROUP BY code ORDER BY count(*) DESC LIMIT 1")).rows[0]?.code ?? null;
        } catch {
            /* tables absentes : les plans concernés le signaleront */
        }
        const hier = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const ilYa7Jours = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
        const ilYa1An = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

        await plan(client, `article par code, avec TRIM (codein ${codein})`,
            "SELECT a.no_id FROM articles a WHERE TRIM(a.codein::text) = $1", [codein ?? ""]);
        await plan(client, `article par code, sans TRIM (codein ${codein})`,
            "SELECT a.no_id FROM articles a WHERE a.codein::text = $1", [codein ?? ""]);
        await plan(client, `Meilleures ventes, 7 derniers jours (${ilYa7Jours} → ${hier})`, HIT_PARADE, [ilYa7Jours, hier]);
        await plan(client, "Dernière réception par fournisseur (Commandes)", DERNIERE_RECEPTION);
        await plan(client, `Ventes mensuelles d'un fournisseur sur 12 mois (fournisseur ${codefou})`, MENSUEL_FOURNISSEUR, [codefou ?? "", ilYa1An, hier]);
        await plan(client, "Stock sans vente (forme simplifiée)", STOCK_SANS_VENTE);
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((e) => {
    console.error("Diagnostic interrompu :", e.message);
    process.exit(1);
});
