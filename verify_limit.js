
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
let url = "";
if (fs.existsSync(CONFIG_PATH)) {
    url = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).url;
}
if (!url) url = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: url });

async function check() {
    try {
        console.log("Checking DB URL:", url.replace(/:([^@]+)@/, ":****@"));
        
        const resTotal = await pool.query('SELECT COUNT(*) FROM ventes_produits');
        console.log("Total rows in table:", resTotal.rows[0].count);

        const resSuppliers = await pool.query('SELECT code_fournisseur, COUNT(*) as count FROM ventes_produits GROUP BY code_fournisseur ORDER BY count DESC LIMIT 10');
        console.log("Top suppliers by row count:", resSuppliers.rows);

        // Check for specific supplier in user screenshot (if any, but I'll check all)
        for (const s of resSuppliers.rows) {
            const resDistinct = await pool.query('SELECT COUNT(DISTINCT codein) FROM ventes_produits WHERE code_fournisseur = $1', [s.code_fournisseur]);
            console.log(`Supplier ${s.code_fournisseur}: Distinct Products = ${resDistinct.rows[0].count}`);
        }

    } catch (e) {
        console.error("DB Error:", e);
    } finally {
        await pool.end();
    }
}
check();
