
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
let url = "";
if (fs.existsSync(CONFIG_PATH)) {
    url = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).url;
}

const pool = new Pool({ connectionString: url || process.env.DATABASE_URL });

async function check() {
    try {
        const resSuppliers = await pool.query(\`SELECT DISTINCT code_fournisseur FROM ventes_produits LIMIT 5\`);
        console.log("Suppliers in DB:", resSuppliers.rows.map(r => r.code_fournisseur));

        for (const row of resSuppliers.rows) {
            const supplier = row.code_fournisseur;
            const countRes = await pool.query(\`SELECT COUNT(*) FROM ventes_produits WHERE code_fournisseur = $1\`, [supplier]);
            const distinctCodein = await pool.query(\`SELECT COUNT(DISTINCT codein) FROM ventes_produits WHERE code_fournisseur = $1\`, [supplier]);
            console.log(\`Supplier \${supplier}: Total Rows = \${countRes.rows[0].count}, Distinct Products = \${distinctCodein.rows[0].count}\`);
        }
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await pool.end();
    }
}
check();
