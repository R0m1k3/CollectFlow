import { NextRequest } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * CollectFlow — Diagnostic « d'où vient le prix de vente ? »
 *
 * La colonne « PV central » de la Grille lit `article_infosup.prix_vente_mini`,
 * seule source de prix de vente câblée dans l'application (Grille et fiche
 * produit la partagent). Quand elle s'affiche vide de bout en bout, deux causes
 * possibles, que seule la base peut départager :
 *
 *   1. la colonne existe mais n'est pas renseignée (ou vaut 0) ;
 *   2. le prix de vente vit ailleurs, sous un autre nom.
 *
 * Cette route répond aux deux : elle compte le remplissage de la colonne
 * actuelle, et énumère les colonnes candidates du schéma avec leur remplissage
 * réel — de quoi rebrancher la Grille sur la bonne source sans deviner.
 *
 * Route de diagnostic, à supprimer une fois la source établie. Elle est derrière
 * l'authentification (cf. `middleware.ts`) et ne renvoie que des comptages et
 * quelques exemples.
 */

/** Identifiant SQL sûr : les noms viennent d'`information_schema`, on le vérifie quand même. */
const identifiantValide = (nom: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(nom);

export async function GET(req: NextRequest) {
    const codefou = req.nextUrl.searchParams.get("fournisseur")?.trim() || null;
    const diagnostic: Record<string, unknown> = {
        lecture: "La Grille (« PV central ») et la fiche produit lisent article_infosup.prix_vente_mini",
        fournisseur: codefou ?? "(non précisé — passez ?fournisseur=CODE pour le détail par fournisseur)",
    };

    // ── 1. Remplissage de la colonne actuellement câblée ────────────────────
    try {
        const r = await db.execute(sql`
            SELECT
                COUNT(*)::int                                            AS lignes,
                COUNT(*) FILTER (WHERE prix_vente_mini IS NULL)::int      AS sans_valeur,
                COUNT(*) FILTER (WHERE prix_vente_mini = 0)::int          AS a_zero,
                COUNT(*) FILTER (WHERE prix_vente_mini > 0)::int          AS renseigne,
                MAX(prix_vente_mini)::float                               AS maximum
            FROM article_infosup
        `);
        diagnostic.prix_vente_mini_global = r.rows[0];
    } catch (e) {
        diagnostic.prix_vente_mini_global = { erreur: (e as Error).message?.slice(0, 200) };
    }

    // ── 2. Le même comptage sur les articles d'un fournisseur ───────────────
    if (codefou) {
        try {
            const r = await db.execute(sql`
                SELECT
                    COUNT(*)::int                                              AS articles,
                    COUNT(ai.artnoid)::int                                     AS avec_fiche_infosup,
                    COUNT(*) FILTER (WHERE ai.prix_vente_mini > 0)::int        AS avec_prix,
                    COUNT(*) FILTER (WHERE ai.prix_vente_mini = 0)::int        AS prix_a_zero,
                    COUNT(*) FILTER (WHERE ai.prix_vente_mini IS NULL)::int    AS prix_absent
                FROM artfou1 af
                JOIN articles a ON a.no_id = af.art_no_id
                LEFT JOIN article_infosup ai ON ai.artnoid = a.no_id
                WHERE af.code = ${codefou} AND a.codein IS NOT NULL
            `);
            diagnostic.pour_ce_fournisseur = r.rows[0];

            const ex = await db.execute(sql`
                SELECT a.codein, a.libelle1, ai.prix_vente_mini::float AS prix_vente_mini
                FROM artfou1 af
                JOIN articles a ON a.no_id = af.art_no_id
                LEFT JOIN article_infosup ai ON ai.artnoid = a.no_id
                WHERE af.code = ${codefou} AND a.codein IS NOT NULL
                LIMIT 8
            `);
            diagnostic.exemples = ex.rows;
        } catch (e) {
            diagnostic.pour_ce_fournisseur = { erreur: (e as Error).message?.slice(0, 200) };
        }
    }

    // ── 2 bis. Les trois sources de prix, côte à côte ───────────────────────
    // `cube_pv` est la source retenue (pendant de `cube_pa` pour l'achat) ;
    // `cube_stock.pv` sert de filet ; `article_infosup` ferme la marche.
    if (codefou) {
        try {
            const r = await db.execute(sql`
                WITH art AS (
                    SELECT DISTINCT a.no_id, a.codein
                    FROM artfou1 af
                    JOIN articles a ON a.no_id = af.art_no_id
                    WHERE af.code = ${codefou} AND a.codein IS NOT NULL
                )
                SELECT
                    (SELECT COUNT(*)::int FROM art)                                                       AS articles,
                    (SELECT COUNT(DISTINCT cpv.artnoid)::int FROM cube_pv cpv
                        JOIN art ON art.no_id = cpv.artnoid WHERE cpv.pv > 0)                             AS avec_cube_pv,
                    (SELECT COUNT(DISTINCT cs.artnoid)::int FROM cube_stock cs
                        JOIN art ON art.no_id = cs.artnoid WHERE cs.pv > 0)                               AS avec_cube_stock_pv,
                    (SELECT COUNT(*)::int FROM article_infosup ai
                        JOIN art ON art.no_id = ai.artnoid WHERE ai.prix_vente_mini > 0)                  AS avec_prix_vente_mini
            `);
            diagnostic.sources_de_prix = {
                commentaire: "nombre d'articles du fournisseur ayant un prix > 0 dans chaque source",
                ...(r.rows[0] as Record<string, unknown>),
            };
        } catch (e) {
            diagnostic.sources_de_prix = { erreur: (e as Error).message?.slice(0, 200) };
        }
    }

    // ── 2 ter. Les valeurs de `site` telles qu'elles sont stockées ──────────
    // Ces chaînes servent de CLÉ de recherche par magasin côté Grille : un
    // espace de remplissage ou un code inattendu et le prix par magasin serait
    // introuvable, sans que rien ne le signale à l'écran.
    try {
        const r = await db.execute(sql`
            SELECT site, LENGTH(site)::int AS longueur, COUNT(*)::int AS lignes
            FROM cube_pv
            GROUP BY site, LENGTH(site)
            ORDER BY lignes DESC
            LIMIT 12
        `);
        diagnostic.sites_cube_pv = {
            commentaire: "la Grille recherche les codes magasin tels quels — longueur 3 attendue pour « 292 » / « 579 »",
            valeurs: r.rows,
        };
    } catch (e) {
        diagnostic.sites_cube_pv = { erreur: (e as Error).message?.slice(0, 200) };
    }

    // ── 3. Colonnes candidates du schéma, et leur remplissage réel ──────────
    // C'est la réponse à « le prix est peut-être ailleurs » : une colonne bien
    // nommée mais vide ne sert à rien, seul le comptage tranche.
    try {
        const candidates = await db.execute(sql`
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND data_type IN ('numeric', 'double precision', 'real', 'integer', 'bigint')
              AND (column_name ILIKE '%prix%' OR column_name ILIKE 'pv%' OR column_name ILIKE '%vente%' OR column_name ILIKE '%tarif%')
            ORDER BY table_name, column_name
            LIMIT 60
        `);
        const lignes = candidates.rows as { table_name: string; column_name: string; data_type: string }[];
        diagnostic.colonnes_candidates = lignes.map((l) => `${l.table_name}.${l.column_name} (${l.data_type})`);

        // Remplissage des colonnes candidates portées par article_infosup :
        // c'est la table déjà jointe, donc la moins coûteuse à rebrancher.
        const surInfosup = lignes.filter((l) => l.table_name === "article_infosup" && identifiantValide(l.column_name));
        if (surInfosup.length > 0) {
            const morceaux = surInfosup.map((l) =>
                sql`COUNT(*) FILTER (WHERE ${sql.raw(`"${l.column_name}"`)} > 0)::int AS ${sql.raw(`"${l.column_name}"`)}`
            );
            const r = await db.execute(sql`SELECT ${sql.join(morceaux, sql`, `)} FROM article_infosup`);
            diagnostic.remplissage_article_infosup = {
                commentaire: "nombre de lignes où la colonne est > 0",
                ...(r.rows[0] as Record<string, unknown>),
            };
        }
    } catch (e) {
        diagnostic.colonnes_candidates = { erreur: (e as Error).message?.slice(0, 200) };
    }

    return Response.json(diagnostic, { headers: { "Cache-Control": "no-store" } });
}
