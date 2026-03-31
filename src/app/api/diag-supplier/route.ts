import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Diagnostic endpoint for supplier attribution investigation.
 * Usage:
 *   /api/diag-supplier                      → top suppliers by CA (current month) both methods
 *   /api/diag-supplier?code=BAZAR5000       → inspect artfou1 entries for that supplier's articles
 */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const supplierCode = searchParams.get("code");

    const mois = "2026-03";
    const moisN1 = "2025-03";

    try {
        if (supplierCode) {
            // Mode inspection : montrer les artfou1 entrées pour ce fournisseur
            const artfou1Rows = await db.execute(sql`
                SELECT af.art_no_id, af.no_id, af.code AS codefou, a.codein,
                       f.raisonsociale AS nom_fournisseur
                FROM artfou1 af
                JOIN articles a ON a.no_id = af.art_no_id
                LEFT JOIN fouadr1 f ON f.code = af.code AND f.sit_code = '000'
                WHERE af.code = ${supplierCode}
                ORDER BY af.art_no_id, af.no_id DESC
                LIMIT 20
            `);

            // Pour ces articles, voir si d'autres fournisseurs existent dans artfou1
            const multiSupplierArticles = await db.execute(sql`
                SELECT a.codein, af.code AS codefou, af.no_id,
                       f.raisonsociale AS nom,
                       ROW_NUMBER() OVER (PARTITION BY af.art_no_id ORDER BY af.no_id DESC) AS rn
                FROM artfou1 af
                JOIN articles a ON a.no_id = af.art_no_id
                LEFT JOIN fouadr1 f ON f.code = af.code AND f.sit_code = '000'
                WHERE af.art_no_id IN (
                    SELECT art_no_id FROM artfou1 WHERE code = ${supplierCode}
                )
                ORDER BY a.codein, af.no_id DESC
                LIMIT 50
            `);

            return NextResponse.json({
                mode: "inspect",
                supplierCode,
                artfou1Sample: artfou1Rows.rows,
                multiSupplierArticles: multiSupplierArticles.rows,
            });
        }

        // Mode comparaison : ancien (ASC) vs nouveau (DESC) pour le mois courant
        const withAsc = await db.execute(sql`
            WITH art_fou AS (
                SELECT DISTINCT ON (art_no_id) art_no_id, code AS codefou
                FROM artfou1
                ORDER BY art_no_id, no_id ASC
            )
            SELECT af.codefou AS code, MAX(f.raisonsociale)::text AS nom,
                   SUM(-m.mntmvtttc)::float AS ca_ttc
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN art_fou af ON af.art_no_id = a.no_id
            JOIN fouadr1 f ON f.code = af.codefou AND f.sit_code = '000'
            WHERE TO_CHAR(m.datmvt, 'YYYY-MM') = ${mois}
              AND m.site IN ('292', '579')
              AND m.genremvt = 3
            GROUP BY af.codefou
            ORDER BY ca_ttc DESC
            LIMIT 15
        `);

        const withDesc = await db.execute(sql`
            WITH art_fou AS (
                SELECT DISTINCT ON (art_no_id) art_no_id, code AS codefou
                FROM artfou1
                ORDER BY art_no_id, no_id DESC
            )
            SELECT af.codefou AS code, MAX(f.raisonsociale)::text AS nom,
                   SUM(-m.mntmvtttc)::float AS ca_ttc
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN art_fou af ON af.art_no_id = a.no_id
            JOIN fouadr1 f ON f.code = af.codefou AND f.sit_code = '000'
            WHERE TO_CHAR(m.datmvt, 'YYYY-MM') = ${mois}
              AND m.site IN ('292', '579')
              AND m.genremvt = 3
            GROUP BY af.codefou
            ORDER BY ca_ttc DESC
            LIMIT 15
        `);

        // Combien d'articles ont plusieurs fournisseurs dans artfou1 ?
        const multiStats = await db.execute(sql`
            SELECT COUNT(*) AS articles_multi_fournisseur,
                   MAX(cnt) AS max_fournisseurs_par_article
            FROM (
                SELECT art_no_id, COUNT(*) AS cnt
                FROM artfou1
                GROUP BY art_no_id
                HAVING COUNT(*) > 1
            ) t
        `);

        // Chercher BAZAR 5000 spécifiquement
        const bazarCode = await db.execute(sql`
            SELECT DISTINCT af.code, f.raisonsociale
            FROM artfou1 af
            JOIN fouadr1 f ON f.code = af.code AND f.sit_code = '000'
            WHERE f.raisonsociale ILIKE '%bazar%'
            LIMIT 5
        `);

        return NextResponse.json({
            mode: "compare",
            mois,
            top15_method_ASC_oldest: withAsc.rows,
            top15_method_DESC_newest: withDesc.rows,
            multi_supplier_stats: multiStats.rows,
            bazar_supplier_codes: bazarCode.rows,
            hint: "Add ?code=BAZAR5000_CODE to inspect specific supplier's articles",
        });

    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
