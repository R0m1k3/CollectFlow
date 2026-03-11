
import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { sql } from "drizzle-orm";

async function main() {
  console.log("--- DB DIAGNOSIS Start ---");
  try {
    const results = await db.execute(sql`
      SELECT 
        code_fournisseur, 
        nom_fournisseur, 
        COUNT(*) as total_rows, 
        COUNT(DISTINCT codein) as distinct_products
      FROM ventes_produits
      GROUP BY code_fournisseur, nom_fournisseur
      ORDER BY total_rows DESC
    `);
    
    console.table(results.rows);
  } catch (error) {
    console.error("Diagnosis failed:", error);
  }
  console.log("--- DB DIAGNOSIS End ---");
}

main();
