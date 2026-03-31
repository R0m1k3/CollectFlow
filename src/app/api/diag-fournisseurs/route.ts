import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
    try {
        // 1. Colonnes de v_ca_fournisseur
        const vCols = await db.execute(sql`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'v_ca_fournisseur'
            ORDER BY ordinal_position
        `);

        // 2. Sample de v_ca_fournisseur
        const vSample = await db.execute(sql`
            SELECT * FROM v_ca_fournisseur LIMIT 10
        `);

        // 3. D005 dans v_ca_fournisseur
        const vD005 = await db.execute(sql`
            SELECT * FROM v_ca_fournisseur
            WHERE code = 'D005' OR codefou = 'D005'
              OR raisonsociale ILIKE '%depot%' OR raisonsociale ILIKE '%bazar%'
            LIMIT 10
        `);

        // 4. Définition SQL de la vue
        const vDef = await db.execute(sql`
            SELECT definition
            FROM pg_views
            WHERE viewname = 'v_ca_fournisseur'
        `);

        return NextResponse.json({
            v_ca_fournisseur_columns: vCols.rows,
            v_ca_fournisseur_sample: vSample.rows,
            v_ca_fournisseur_d005: vD005.rows,
            view_definition: vDef.rows,
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
