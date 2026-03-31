import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
    try {
        // 1. Colonnes réelles de fouadr1
        const cols = await db.execute(sql`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'fouadr1'
            ORDER BY ordinal_position
        `);

        // 2. Toutes les tables contenant "fou"
        const tables = await db.execute(sql`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name ILIKE '%fou%'
            ORDER BY table_name
        `);

        // 3. Sample de fouadr1 (5 lignes brutes)
        const sample = await db.execute(sql`SELECT * FROM fouadr1 LIMIT 5`);

        // 4. Sample de fouadr1 pour code D005
        const d005 = await db.execute(sql`SELECT * FROM fouadr1 WHERE code = 'D005' LIMIT 10`);

        return NextResponse.json({
            fouadr1_columns: cols.rows,
            tables_with_fou: tables.rows,
            fouadr1_sample: sample.rows,
            fouadr1_d005: d005.rows,
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
