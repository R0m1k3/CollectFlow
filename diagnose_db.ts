
import { db } from "./src/db";
import { ventesProduits } from "./src/db/schema";
import { sql } from "drizzle-orm";

async function diagnose() {
    console.log("Checking DB connection...");
    try {
        const result = await db.execute(sql`SELECT 1`);
        console.log("DB Connection OK.");

        console.log("Checking table 'ventes_produits'...");
        const tableCheck = await db.execute(sql`SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = 'ventes_produits'
    )`);
        console.log("Table exists:", tableCheck.rows[0].exists);

        if (tableCheck.rows[0].exists) {
            const count = await db.select({ count: sql`count(*)` }).from(ventesProduits);
            console.log("Total rows in 'ventes_produits':", count[0].count);
        }
    } catch (err) {
        console.error("Diagnosis failed:", err);
    } finally {
        process.exit(0);
    }
}

diagnose();
