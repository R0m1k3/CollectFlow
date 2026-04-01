import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
    try {
        // Colonnes de mvtart
        const cols = await db.execute(sql`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'mvtart'
            ORDER BY ordinal_position
        `);

        // 5 ventes récentes avec tous les montants visibles
        const sample = await db.execute(sql`
            SELECT *
            FROM mvtart
            WHERE genremvt = 3 AND site IN ('292', '579')
            ORDER BY datmvt DESC
            LIMIT 5
        `);

        // CA mars 2025 par site via mntmvtttc — pour comparer avec le cube
        const totaux = await db.execute(sql`
            SELECT site,
                   ABS(SUM(mntmvtttc))::float AS ca_mntmvtttc,
                   COUNT(*) AS nb_lignes
            FROM mvtart
            WHERE genremvt = 3
              AND TO_CHAR(datmvt, 'YYYY-MM') = '2025-03'
              AND site IN ('292', '579')
            GROUP BY site
        `);

        return NextResponse.json({
            columns: cols.rows,
            sample_ventes: sample.rows,
            totaux_202503: totaux.rows,
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
