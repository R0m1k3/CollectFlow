import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const codeFournisseur = searchParams.get("fournisseur");

    if (!codeFournisseur) {
        return NextResponse.json({ 
            error: "Paramètre 'fournisseur' manquant.",
            usage: "/api/diag?fournisseur=VOTRE_CODE"
        }, { status: 400 });
    }

    try {
        console.log(`\n--- [DIAG API] Starting check for supplier: ${codeFournisseur} ---`);
        
        // 1. Raw Count
        const countAll = await db.execute(sql`
            SELECT COUNT(*) as count FROM ventes_produits 
            WHERE code_fournisseur = ${codeFournisseur}
        `);
        const totalRows = Number(countAll.rows[0].count);

        // 2. Distinct Products
        const countDistinctTotal = await db.execute(sql`
            SELECT COUNT(DISTINCT codein) as count FROM ventes_produits 
            WHERE code_fournisseur = ${codeFournisseur}
        `);
        const totalDistinct = Number(countDistinctTotal.rows[0].count);

        // 3. Sample of data (to see if it's truncated by DB query)
        const sample = await db.execute(sql`
            SELECT codein, libelle1, magasin, periode FROM ventes_produits 
            WHERE code_fournisseur = ${codeFournisseur}
            LIMIT 5
        `);

        console.log(`- DB sees ${totalRows} total rows.`);
        console.log(`- DB sees ${totalDistinct} distinct products.`);

        return NextResponse.json({
            timestamp: new Date().toISOString(),
            supplier: codeFournisseur,
            database: {
                totalRowsInTable: totalRows,
                distinctProducts: totalDistinct,
                sampleData: sample.rows
            },
            serverConfig: {
                nextVersion: "16.1.6",
                nodeEnv: process.env.NODE_ENV,
                bodySizeLimit: "50mb"
            },
            message: totalDistinct > 1000 
                ? "La base de données contient plus de 1000 produits. Si la grille en affiche 999, le problème est dans le transport (Application/RSC)." 
                : "La base de données renvoie moins de 1000 produits uniques. Le problème vient de l'import ou du filtrage SQL."
        });

    } catch (error: any) {
        console.error("[DIAG API] Error:", error);
        return NextResponse.json({ 
            error: "Failed to fetch diagnostic data", 
            details: error.message 
        }, { status: 500 });
    }
}
