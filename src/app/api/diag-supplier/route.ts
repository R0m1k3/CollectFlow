import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const supplierCode = searchParams.get("code");
    const mois = "2026-03";

    try {
        if (supplierCode) {
            // ── Inspection d'un fournisseur spécifique ──────────────────────────

            // 1. Articles attribués à ce code via DESC (méthode actuelle)
            const articlesDesc = await db.execute(sql`
                WITH art_fou AS (
                    SELECT DISTINCT ON (art_no_id) art_no_id, code AS codefou
                    FROM artfou1
                    ORDER BY art_no_id, no_id DESC
                )
                SELECT a.codein, a.libelle1,
                       af.codefou AS codefou_courant,
                       -- Tous les fournisseurs de cet article dans artfou1
                       (SELECT STRING_AGG(af2.code || '(' || af2.no_id || ')', ',' ORDER BY af2.no_id)
                        FROM artfou1 af2 WHERE af2.art_no_id = a.no_id) AS tous_fournisseurs,
                       -- Dernière réception (livraison)
                       (SELECT TO_CHAR(MAX(m2.datmvt), 'YYYY-MM-DD')
                        FROM mvtart m2 WHERE m2.artnoid = a.no_id AND m2.genremvt IN (1,2)) AS derniere_reception,
                       -- CA du mois sur cet article
                       (SELECT SUM(-m3.mntmvtttc) FROM mvtart m3
                        WHERE m3.artnoid = a.no_id AND TO_CHAR(m3.datmvt,'YYYY-MM') = ${mois}
                          AND m3.genremvt = 3) AS ca_mois
                FROM art_fou af
                JOIN articles a ON a.no_id = af.art_no_id
                WHERE af.codefou = ${supplierCode}
                ORDER BY ca_mois DESC NULLS LAST
                LIMIT 20
            `);

            // 2. CA total attribué à ce code ce mois
            const caMois = await db.execute(sql`
                WITH art_fou AS (
                    SELECT DISTINCT ON (art_no_id) art_no_id, code AS codefou
                    FROM artfou1
                    ORDER BY art_no_id, no_id DESC
                )
                SELECT SUM(-m.mntmvtttc)::float AS ca_total, COUNT(DISTINCT m.artnoid) AS nb_articles
                FROM mvtart m
                JOIN art_fou af ON af.art_no_id = m.artnoid
                WHERE af.codefou = ${supplierCode}
                  AND TO_CHAR(m.datmvt,'YYYY-MM') = ${mois}
                  AND m.genremvt = 3
            `);

            // 3. Y a-t-il des réceptions récentes pour ce fournisseur ?
            const recentReceptions = await db.execute(sql`
                SELECT TO_CHAR(m.datmvt,'YYYY-MM') AS mois_reception,
                       COUNT(*) AS nb_lignes,
                       SUM(m.qtemvt)::float AS qte_recue
                FROM mvtart m
                JOIN articles a ON a.no_id = m.artnoid
                JOIN artfou1 af ON af.art_no_id = a.no_id AND af.code = ${supplierCode}
                WHERE m.genremvt IN (1,2)
                  AND m.datmvt >= NOW() - INTERVAL '18 months'
                GROUP BY TO_CHAR(m.datmvt,'YYYY-MM')
                ORDER BY mois_reception DESC
                LIMIT 12
            `);

            return NextResponse.json({
                mode: "inspect",
                supplierCode,
                ca_mois: caMois.rows[0],
                articles_top20_par_ca: articlesDesc.rows,
                receptions_18_derniers_mois: recentReceptions.rows,
            });
        }

        // ── Mode comparaison global ──────────────────────────────────────────────

        // Méthode 1 : artfou1 DESC (actuelle)
        const desc = await db.execute(sql`
            WITH art_fou AS (
                SELECT DISTINCT ON (art_no_id) art_no_id, code AS codefou
                FROM artfou1 ORDER BY art_no_id, no_id DESC
            )
            SELECT af.codefou AS code, MAX(f.raisonsociale)::text AS nom,
                   ROUND(SUM(-m.mntmvtttc)::numeric, 0) AS ca_ttc
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN art_fou af ON af.art_no_id = a.no_id
            JOIN fouadr1 f ON f.code = af.codefou AND f.sit_code = '000'
            WHERE TO_CHAR(m.datmvt,'YYYY-MM') = ${mois}
              AND m.site IN ('292','579') AND m.genremvt = 3
            GROUP BY af.codefou ORDER BY ca_ttc DESC LIMIT 15
        `);

        // Méthode 2 : dernière RÉCEPTION comme attribution (plus fiable)
        const byLastReception = await db.execute(sql`
            WITH last_reception AS (
                -- Pour chaque article, dernier fournisseur qui a livré (genremvt 1 ou 2)
                SELECT DISTINCT ON (m.artnoid)
                    m.artnoid,
                    af.code AS codefou,
                    m.datmvt AS date_reception
                FROM mvtart m
                JOIN artfou1 af ON af.art_no_id = m.artnoid
                WHERE m.genremvt IN (1, 2)
                ORDER BY m.artnoid, m.datmvt DESC, af.no_id DESC
            )
            SELECT lr.codefou AS code, MAX(f.raisonsociale)::text AS nom,
                   ROUND(SUM(-m.mntmvtttc)::numeric, 0) AS ca_ttc,
                   MIN(TO_CHAR(lr.date_reception,'YYYY-MM-DD')) AS plus_ancienne_recep,
                   MAX(TO_CHAR(lr.date_reception,'YYYY-MM-DD')) AS plus_recente_recep
            FROM mvtart m
            JOIN last_reception lr ON lr.artnoid = m.artnoid
            JOIN fouadr1 f ON f.code = lr.codefou AND f.sit_code = '000'
            WHERE TO_CHAR(m.datmvt,'YYYY-MM') = ${mois}
              AND m.site IN ('292','579') AND m.genremvt = 3
            GROUP BY lr.codefou ORDER BY ca_ttc DESC LIMIT 15
        `);

        // Stats multi-fournisseurs
        const stats = await db.execute(sql`
            SELECT COUNT(*) AS articles_multi_fournisseur,
                   MAX(cnt) AS max_fournisseurs_par_article,
                   SUM(CASE WHEN cnt = 1 THEN 1 ELSE 0 END) AS articles_unique_fournisseur
            FROM (SELECT art_no_id, COUNT(*) AS cnt FROM artfou1 GROUP BY art_no_id) t
        `);

        // Codes BAZAR 5000
        const bazar = await db.execute(sql`
            SELECT DISTINCT af.code, f.raisonsociale,
                   COUNT(af.art_no_id) AS nb_articles_lies
            FROM artfou1 af
            JOIN fouadr1 f ON f.code = af.code AND f.sit_code = '000'
            WHERE f.raisonsociale ILIKE '%bazar%'
            GROUP BY af.code, f.raisonsociale
        `);

        return NextResponse.json({
            mode: "compare",
            mois,
            method_DESC_artfou1_newest: desc.rows,
            method_last_reception: byLastReception.rows,
            multi_supplier_stats: stats.rows[0],
            bazar_codes: bazar.rows,
            next_steps: "Add ?code=D005 or ?code=B0071 to inspect specific supplier articles",
        });

    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
