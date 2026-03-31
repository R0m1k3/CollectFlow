import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
    try {
        // 1. Tous les sit_code distincts dans fouadr1
        const sitCodes = await db.execute(sql`
            SELECT sit_code, COUNT(*) AS nb
            FROM fouadr1
            GROUP BY sit_code
            ORDER BY nb DESC
        `);

        // 2. D005 dans tous les sit_code
        const d005 = await db.execute(sql`
            SELECT sit_code, code, raisonsociale, ville, pays
            FROM fouadr1
            WHERE code = 'D005'
            ORDER BY sit_code
        `);

        // 3. Liste complète des fournisseurs actifs (avec CA récent) par sit_code
        // → comparer la même liste sur sit_code='000' vs le vrai sit_code utilisé
        const allSitCodes = (sitCodes.rows as any[]).map(r => r.sit_code);

        // 4. Top fournisseurs dans chaque sit_code pour D005, J009, M0341
        const sample = await db.execute(sql`
            SELECT sit_code, code, raisonsociale
            FROM fouadr1
            WHERE code IN ('D005','J009','M0341','L0091','S053','B0071','C024','T015')
            ORDER BY code, sit_code
        `);

        // 5. Liste complète fouadr1 sans filtre sit_code pour avoir tous les noms
        const fullList = await db.execute(sql`
            SELECT DISTINCT ON (code) code, raisonsociale, sit_code
            FROM fouadr1
            WHERE raisonsociale IS NOT NULL
              AND raisonsociale != ''
            ORDER BY code, sit_code
            LIMIT 200
        `);

        // 6. Est-ce qu'il y a une autre table de fournisseurs ?
        const otherTables = await db.execute(sql`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name ILIKE '%fou%'
            ORDER BY table_name
        `);

        return NextResponse.json({
            sit_codes_in_fouadr1: sitCodes.rows,
            d005_all_sit_codes: d005.rows,
            sample_known_suppliers: sample.rows,
            full_list_no_filter: fullList.rows,
            tables_with_fou: otherTables.rows,
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
