/**
 * CollectFlow — Client PostgreSQL FF Nancy
 *
 * Remplace les appels HTTP per-article vers api.ffnancy.fr par des requêtes
 * SQL bulk directes sur la base PostgreSQL FF Nancy.
 *
 * Chaque fonction fait 1 seule requête filtrée par codefou — O(1) au lieu de O(N).
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";

// Cache module-level pour éviter les requêtes information_schema répétées
let _nomenclatureParentCol: string | null | undefined = undefined; // undefined = pas encore chargé

// ---------------------------------------------------------------------------
// Types résultats SQL
// ---------------------------------------------------------------------------

export interface PgArticle {
    no_id: number;
    codein: string;
    codefou: string;
    nomfou?: string;
    libelle1?: string;
    pcb?: number;
    reference?: string;
    ean13?: string;
    gtin?: string;          // art_gtin.gtin (préférentiel)
    pv_central?: number;    // article_infosup.prix_vente_mini
    pa?: number;            // cube_pa.pa
}

export interface PgMensuelRow {
    codein: string;
    site: string;
    mois: string;           // "YYYY-MM"
    qte_vendue: number;
    ca_ht: number;          // mntmvtttc (à vérifier si HT ou TTC)
    marge: number;
    stock_fin_mois: number; // MAX(qtestock) sur le mois
    qte_recue: number;
}

export interface PgStockRow {
    codein: string;
    site: string;
    stockdispo: number;
    qte: number;
    valstock: number;
    prmp: number;
    dernierevente?: string;
    dernierereception?: string;
}

export interface PgRankingRow {
    codein: string;
    site: string;
    ranking_ca?: number;
    ranking_qte?: number;
    ranking_mag_ca?: number;
    ranking_mag_qte?: number;
}

// ---------------------------------------------------------------------------
// 0. Liste des fournisseurs
// ---------------------------------------------------------------------------

/**
 * Retourne la liste de tous les fournisseurs depuis fouadr1.
 * 1 requête SQL — remplace getFournisseursFromApi().
 */
export async function pgGetFournisseurs(search?: string): Promise<{ code: string; nom: string }[]> {
    // Jointure avec artfou1 pour ne retourner QUE les fournisseurs ayant des articles
    const result = await db.execute(sql`
        SELECT DISTINCT
            fa.code,
            fa.raisonsociale AS nom
        FROM fouadr1 fa
        INNER JOIN artfou1 af ON af.code = fa.code
        WHERE fa.sit_code = '000'
          AND fa.raisonsociale IS NOT NULL
          AND fa.code IS NOT NULL
          -- Exclure les raisonsociales qui commencent par un chiffre (adresses postales)
          AND fa.raisonsociale !~ '^\s*\d'
          ${search ? sql`AND (fa.raisonsociale ILIKE ${'%' + search + '%'} OR fa.code ILIKE ${'%' + search + '%'})` : sql``}
        ORDER BY fa.raisonsociale
    `);

    return (result.rows as unknown as { code: string; nom: string }[])
        .filter(r => r.code && r.nom);
}

// ---------------------------------------------------------------------------
// 1. Articles du fournisseur
// ---------------------------------------------------------------------------

/**
 * Retourne tous les articles d'un fournisseur avec leurs métadonnées.
 * 1 seule requête SQL — remplace getArticlesByFournisseur() + per-article fetches.
 */
export async function pgGetArticlesByFournisseur(codefou: string): Promise<PgArticle[]> {
    // Filtrage sur les articles "actifs" uniquement :
    //   - avec gamme affectée (art_gamme_saison) → à gérer même sans ventes
    //   - OU avec au moins 1 vente sur les 12 derniers mois (mvtart genremvt=3)
    // Cela évite d'envoyer 50 000 lignes vides pour les gros fournisseurs → page blanche
    const result = await db.execute(sql`
        SELECT
            a.no_id,
            a.codein,
            af.code                     AS codefou,
            fa.raisonsociale            AS nomfou,
            a.libelle1,
            af.pcb,
            af.reference,
            af.ean13,
            COALESCE(ag.gtin, af.ean13) AS gtin,
            ai.prix_vente_mini          AS pv_central,
            pa.pa
        FROM artfou1 af
        JOIN articles a
            ON a.no_id = af.art_no_id
        -- Seulement articles avec gamme OU avec ventes récentes
        JOIN (
            SELECT artnoid FROM art_gamme_saison
            UNION
            SELECT artnoid FROM mvtart
            WHERE genremvt = 3
              AND datmvt >= CURRENT_DATE - INTERVAL '12 months'
        ) actif ON actif.artnoid = a.no_id
        LEFT JOIN fouadr1 fa
            ON fa.code = af.code AND fa.sit_code = '000'
        LEFT JOIN article_infosup ai
            ON ai.artnoid = a.no_id
        LEFT JOIN cube_pa pa
            ON pa.artnoid = a.no_id
        LEFT JOIN art_gtin ag
            ON ag.idarticle = a.no_id AND ag.preferentiel = 1
        WHERE af.code = ${codefou}
          AND a.codein IS NOT NULL
        ORDER BY a.codein
    `);

    console.log(`[pg-ff] Articles actifs: ${result.rows.length} pour ${codefou}`);
    return (result.rows as unknown as PgArticle[]).filter(r => r.codein);
}

// ---------------------------------------------------------------------------
// 2. Données mensuelles (ventes + stock + réceptions)
// ---------------------------------------------------------------------------

/**
 * Retourne les données mensuelles agrégées par (codein, site, mois).
 * 1 seule requête SQL — remplace getMensuelByArticles() (N appels HTTP).
 *
 * genremvt = 3  → ventes clients
 * genremvt 1/2  → réceptions (à confirmer selon nomenclature FF Nancy)
 * qtestock      → stock après mouvement (MAX du mois ≈ stock fin de mois)
 */
export async function pgGetMensuelByFournisseur(
    codefou: string,
    dateDebut: string,
    dateFin: string
): Promise<PgMensuelRow[]> {
    // IMPORTANT : utiliser DISTINCT sur artfou1 pour éviter les doublons de mouvements.
    // Un article peut avoir plusieurs lignes artfou1 pour le même fournisseur (pcb/ref différents),
    // ce qui multiplierait chaque mouvement et gonflerait les totaux.
    const result = await db.execute(sql`
        SELECT
            a.codein,
            m.site,
            TO_CHAR(m.datmvt, 'YYYY-MM')                                          AS mois,
            SUM(CASE WHEN m.genremvt = 3 THEN ABS(m.qtemvt)    ELSE 0 END)::float AS qte_vendue,
            SUM(CASE WHEN m.genremvt = 3 THEN ABS(m.mntmvtttc) ELSE 0 END)::float AS ca_ht,
            SUM(CASE WHEN m.genremvt = 3 THEN m.margemvt        ELSE 0 END)::float AS marge,
            MAX(m.qtestock)::float                                                  AS stock_fin_mois,
            SUM(CASE WHEN m.genremvt IN (1, 2) THEN ABS(m.qtemvt) ELSE 0 END)::float AS qte_recue
        FROM mvtart m
        JOIN articles a ON a.no_id = m.artnoid
        -- Sous-requête dédupliquée : 1 seule ligne par article/fournisseur
        JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = ${codefou}) af
            ON af.art_no_id = a.no_id
        WHERE m.datmvt BETWEEN ${dateDebut}::date AND ${dateFin}::date
          AND m.site IN ('292', '579')
        GROUP BY a.codein, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
        ORDER BY a.codein, m.site, mois
    `);

    return result.rows as unknown as PgMensuelRow[];
}

// ---------------------------------------------------------------------------
// 3. Gammes (saison active)
// ---------------------------------------------------------------------------

/**
 * Retourne la gamme courante (saison active) pour chaque article du fournisseur.
 * 1 requête SQL — remplace getReferentielByArticles() pour la partie gammes.
 */
export async function pgGetGammesByFournisseur(codefou: string): Promise<Map<string, string>> {
    // DISTINCT ON (codein) → 1 gamme par article, saison la plus récente en premier
    // saisons n'a PAS de colonne "actif" → pas de filtre actif
    const result = await db.execute(sql`
        SELECT DISTINCT ON (a.codein)
            a.codein,
            g.code AS gamme_code
        FROM art_gamme_saison ags
        JOIN articles a  ON a.no_id = ags.artnoid
        JOIN artfou1 af  ON af.art_no_id = a.no_id AND af.code = ${codefou}
        JOIN gammes g    ON g.no_id = ags.idgamme
        JOIN saisons s   ON s.no_id = ags.idsaison
        ORDER BY a.codein, s.no_id DESC
    `);

    const map = new Map<string, string>();
    for (const row of result.rows as unknown as { codein: string; gamme_code: string }[]) {
        if (row.codein && row.gamme_code) map.set(row.codein, String(row.gamme_code).trim());
    }
    if (result.rows.length > 0) {
        console.log("[pg-ff] Gammes sample row:", JSON.stringify(result.rows[0]));
    }
    console.log(`[pg-ff] Gammes: ${map.size} articles avec gamme`);
    return map;
}

// ---------------------------------------------------------------------------
// 4. Nomenclature (famille / sous-famille)
// ---------------------------------------------------------------------------

export interface PgNomRow {
    codein: string;
    code3: string;    // code feuille (ex: "360504")
    libelle3: string; // libellé feuille
    code2?: string;   // famille (4 chiffres)
    libelle2?: string;
    code1?: string;   // secteur (2 chiffres)
    libelle1nom?: string;
}

/**
 * Retourne la nomenclature (famille/sous-famille) pour chaque article du fournisseur.
 * FK confirmée : articles.nom_no_id → nomenclature.no_id
 * Colonnes confirmées : nomenclature.code, nomenclature.libelle
 * Colonne parent : découverte dynamiquement via information_schema
 */
export async function pgGetNomenclatureByFournisseur(codefou: string): Promise<Map<string, PgNomRow>> {
    // Découverte de la colonne parent : mise en cache module-level (1 seule fois par process)
    if (_nomenclatureParentCol === undefined) {
        const metaResult = await db.execute(sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'nomenclature' ORDER BY ordinal_position
        `);
        const nomCols = (metaResult.rows as { column_name: string }[]).map(r => r.column_name);
        console.log("[pg-ff] Nomenclature colonnes:", nomCols.join(", "));
        _nomenclatureParentCol = nomCols.find(c => /parent/i.test(c) || (c !== "no_id" && /no_id$/i.test(c))) ?? null;
        console.log("[pg-ff] Nomenclature parentCol:", _nomenclatureParentCol);
    }
    const parentCol = _nomenclatureParentCol;

    let result;
    if (parentCol) {
        result = await db.execute(sql`
            SELECT
                a.codein,
                n3.code       AS code3,
                n3.libelle    AS libelle3,
                n2.code       AS code2,
                n2.libelle    AS libelle2,
                n1.code       AS code1,
                n1.libelle    AS libelle1nom
            FROM artfou1 af
            JOIN articles a      ON a.no_id = af.art_no_id AND af.code = ${codefou}
            JOIN nomenclature n3 ON n3.no_id = a.nom_no_id
            LEFT JOIN nomenclature n2 ON n2.no_id = n3.${sql.raw(parentCol)}
            LEFT JOIN nomenclature n1 ON n1.no_id = n2.${sql.raw(parentCol)}
            WHERE a.codein IS NOT NULL
        `);
    } else {
        // Sans hiérarchie : juste le niveau feuille
        result = await db.execute(sql`
            SELECT
                a.codein,
                n3.code       AS code3,
                n3.libelle    AS libelle3
            FROM artfou1 af
            JOIN articles a      ON a.no_id = af.art_no_id AND af.code = ${codefou}
            JOIN nomenclature n3 ON n3.no_id = a.nom_no_id
            WHERE a.codein IS NOT NULL
        `);
    }

    console.log(`[pg-ff] Nomenclature: ${result.rows.length} articles, parentCol="${parentCol ?? "none"}"`);
    if (result.rows.length > 0) console.log("[pg-ff] Nomenclature sample:", JSON.stringify(result.rows[0]));
    return buildNomMap(result.rows as unknown as PgNomRow[]);
}

function buildNomMap(rows: PgNomRow[]): Map<string, PgNomRow> {
    const map = new Map<string, PgNomRow>();
    for (const r of rows) {
        if (r.codein) map.set(r.codein, r);
    }
    return map;
}

// ---------------------------------------------------------------------------
// 5. Stock temps réel (cube_stock)
// ---------------------------------------------------------------------------

/**
 * Retourne le stock actuel par site pour chaque article du fournisseur.
 * 1 requête SQL — remplace la partie stock du référentiel.
 */
export async function pgGetStockByFournisseur(codefou: string): Promise<Map<string, PgStockRow[]>> {
    const result = await db.execute(sql`
        SELECT
            a.codein,
            cs.site,
            cs.stockdispo::float,
            cs.qte::float,
            cs.valstock::float,
            cs.prmp::float,
            cs.dernierevente::text,
            cs.dernierereception::text
        FROM cube_stock cs
        JOIN articles a ON a.no_id = cs.artnoid
        JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = ${codefou}) af
            ON af.art_no_id = a.no_id
    `);

    const map = new Map<string, PgStockRow[]>();
    for (const row of result.rows as unknown as PgStockRow[]) {
        if (!map.has(row.codein)) map.set(row.codein, []);
        map.get(row.codein)!.push(row);
    }
    return map;
}

// ---------------------------------------------------------------------------
// 5. Ranking réseau
// ---------------------------------------------------------------------------

/**
 * Retourne le classement réseau pour chaque article du fournisseur.
 * 1 requête SQL — remplace getRankingByArticles() (N appels HTTP per-article,
 * capés à 500 par l'API).
 */
export async function pgGetRankingByFournisseur(codefou: string): Promise<{
    rankings: Map<string, PgRankingRow>;
    totalRankedProducts: number;
}> {
    // D'abord, découvrir quels sites existent dans la table ranking (réseau vs magasin)
    const [rankResult, totalResult, sitesSample] = await Promise.all([
        db.execute(sql`
            SELECT DISTINCT ON (a.codein)
                a.codein,
                r.site,
                r.ranking_ca,
                r.ranking_qte,
                r.ranking_mag_ca,
                r.ranking_mag_qte
            FROM ranking r
            JOIN art_gtin ag
                ON ag.gtin = r.gencod
            JOIN articles a
                ON a.no_id = ag.idarticle
            JOIN artfou1 af
                ON af.art_no_id = a.no_id AND af.code = ${codefou}
            -- Priorité : site réseau (000, ALL, TOTAL) avant sites magasins
            ORDER BY a.codein,
                CASE
                    WHEN r.site IN ('000', 'ALL', 'TOTAL', 'NET', 'RES') THEN 0
                    ELSE 1
                END,
                r.site
        `),
        db.execute(sql`
            SELECT COUNT(DISTINCT gencod)::int AS total FROM ranking
        `),
        db.execute(sql`
            SELECT DISTINCT site FROM ranking ORDER BY site LIMIT 10
        `),
    ]);

    // Log sites disponibles pour diagnostic ranking
    const sitesDispos = (sitesSample.rows as { site: string }[]).map(r => r.site);
    console.log(`[pg-ff] Ranking sites disponibles:`, sitesDispos.join(", "));

    const rankings = new Map<string, PgRankingRow>();
    for (const row of rankResult.rows as unknown as PgRankingRow[]) {
        if (row.codein) rankings.set(row.codein, row);
    }

    // Log doublons de rank pour diagnostic
    const rankCount = new Map<number, number>();
    for (const r of rankings.values()) {
        if (r.ranking_ca) {
            const v = Number(r.ranking_ca);
            rankCount.set(v, (rankCount.get(v) ?? 0) + 1);
        }
    }
    const dupes = [...rankCount.entries()].filter(([, c]) => c > 1).slice(0, 5);
    if (dupes.length > 0) {
        console.log(`[pg-ff] Ranking doublons détectés (rank → nb articles):`, dupes.map(([r, c]) => `rank${r}×${c}`).join(", "));
    }

    const totalRankedProducts = Number((totalResult.rows[0] as unknown as { total: number })?.total ?? 0);
    console.log(`[pg-ff] Ranking: ${rankings.size} articles classés, réseau total: ${totalRankedProducts}`);

    return { rankings, totalRankedProducts };
}

// ---------------------------------------------------------------------------
// 6. Commandes en cours
// ---------------------------------------------------------------------------

/**
 * Retourne les quantités commandées en cours pour chaque article du fournisseur.
 * 1 requête SQL — remplace getCommandesByFournisseur().
 */
export async function pgGetCommandesByFournisseur(codefou: string): Promise<Map<string, number>> {
    // cdefou_vivant est une vue dénormalisée : articles_codein et cdefou_ligne_qtecde disponibles directement
    const result = await db.execute(sql`
        SELECT
            cv.articles_codein              AS codein,
            SUM(cv.cdefou_ligne_qtecde)::float AS qtecde
        FROM cdefou_vivant cv
        JOIN artfou1 af ON af.no_id = cv.artfou1_no_id AND af.code = ${codefou}
        WHERE cv.articles_codein IS NOT NULL
        GROUP BY cv.articles_codein
    `);

    const map = new Map<string, number>();
    for (const row of result.rows as unknown as { codein: string; qtecde: number }[]) {
        if (row.codein) map.set(row.codein, Number(row.qtecde) || 0);
    }
    return map;
}
