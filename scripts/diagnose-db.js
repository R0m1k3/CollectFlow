
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log("--- DB DIAGNOSIS Start (Node) ---");
  
  let connectionString = process.env.DATABASE_URL;
  
  try {
    const CONFIG_PATH = path.join(process.cwd(), "data", ".db-config.json");
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      if (config.url) {
        connectionString = config.url;
      }
    }
  } catch (err) {}

  if (!connectionString) {
    console.error("No connection string found.");
    return;
  }

  const pool = new Pool({ connectionString });

  try {
    const res = await pool.query(`
      SELECT 
        code_fournisseur, 
        nom_fournisseur, 
        COUNT(*) as total_rows, 
        COUNT(DISTINCT codein) as distinct_products
      FROM ventes_produits
      GROUP BY code_fournisseur, nom_fournisseur
      ORDER BY total_rows DESC
    `);
    
    console.table(res.rows);
  } catch (error) {
    console.error("Diagnosis failed:", error);
  } finally {
    await pool.end();
  }
}

main();
