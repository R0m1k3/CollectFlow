import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import { pgGetStockForCodeins } from '@/lib/pg-ff-client';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const codein = searchParams.get('codein') || '334152';
        
        const map = await pgGetStockForCodeins([codein]);
        
        const fouResult = await db.execute(sql`
            SELECT
                a.codein::text AS codein,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur
            FROM articles a
            LEFT JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
            LEFT JOIN fouident fi ON fi.code = af.code
            WHERE a.codein::text = ${codein}
        `);

        return NextResponse.json({
            stock: Object.fromEntries(map),
            fou: fouResult.rows,
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
    }
}
