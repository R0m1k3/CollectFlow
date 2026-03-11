
import { db } from "./src/db";
import { sql } from "drizzle-orm";

async function check() {
    try {
        const res = await db.execute(sql`SELECT COUNT(*) FROM ventes_produits`);
        console.log("Total rows in ventes_produits:", res.rows[0].count);
        
        const resDistinct = await db.execute(sql`SELECT COUNT(DISTINCT codein) FROM ventes_produits`);
        console.log("Total distinct codein in ventes_produits:", resDistinct.rows[0].count);
        
        const resSupplier = await db.execute(sql`SELECT code_fournisseur, COUNT(*) as row_count, COUNT(DISTINCT codein) as prod_count FROM ventes_produits GROUP BY code_fournisseur`);
        console.log("Counts per supplier:", resSupplier.rows);
    } catch (e) {
        console.error("Error:", e);
    }
}
check();
