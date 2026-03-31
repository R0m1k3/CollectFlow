import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
    try {
        // 1. Colonnes de fouident
        const cols = await db.execute(sql`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'fouident'
            ORDER BY ordinal_position
        `);

        // 2. Sample fouident
        const sample = await db.execute(sql`SELECT * FROM fouident LIMIT 10`);

        // 3. D005 dans fouident
        const d005 = await db.execute(sql`SELECT * FROM fouident WHERE code = 'D005' LIMIT 5`);

        // 4. Nos fournisseurs clés pour comparer les noms
        const known = await db.execute(sql`
            SELECT * FROM fouident
            WHERE code IN ('D005','J009','M0341','L0091','S053','B0071','T015','C024','S025','C023')
            ORDER BY code
        `);

        return NextResponse.json({
            fouident_columns: cols.rows,
            fouident_sample: sample.rows,
            fouident_d005: d005.rows,
            fouident_known: known.rows,
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
