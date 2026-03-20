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
    const result = await db.execute(sql`
        SELECT DISTINCT
            fa.code,
            fa.raisonsociale AS nom
        FROM fouadr1 fa
        WHERE fa.sit_code = '000'
          AND fa.raisonsociale IS NOT NULL
          AND fa.code IS NOT NULL
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
        JOIN articles a
            ON a.no_id = m.artnoid
        JOIN artfou1 af
            ON af.art_no_id = a.no_id AND af.code = ${codefou}
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
 * Colonnes confirmées : nomenclature.code, nomenclature.libelle, nomenclature.parent_no_id
 */
export async function pgGetNomenclatureByFournisseur(codefou: string): Promise<Map<string, PgNomRow>> {
    const result = await db.execute(sql`
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
        LEFT JOIN nomenclature n2 ON n2.no_id = n3.parent_no_id
        LEFT JOIN nomenclature n1 ON n1.no_id = n2.parent_no_id
        WHERE a.codein IS NOT NULL
    `);

    console.log(`[pg-ff] Nomenclature: ${result.rows.length} articles`);
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
        JOIN articles a
            ON a.no_id = cs.artnoid
        JOIN artfou1 af
            ON af.art_no_id = a.no_id AND af.code = ${codefou}
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
    const [rankResult, totalResult] = await Promise.all([
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
            ORDER BY a.codein, r.site
        `),
        db.execute(sql`
            SELECT COUNT(DISTINCT gencod)::int AS total FROM ranking
        `),
    ]);

    const rankings = new Map<string, PgRankingRow>();
    for (const row of rankResult.rows as unknown as PgRankingRow[]) {
        if (row.codein) rankings.set(row.codein, row);
    }

    const totalRankedProducts = Number((totalResult.rows[0] as unknown as { total: number })?.total ?? 0);
    console.log(`[pg-ff] Ranking: ${rankings.size}/${codefou} articles classés (réseau: ${totalRankedProducts})`);

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
    // Découvrir la colonne quantité dans cdefou_vivant (qtecde n'existe pas)
    const metaResult = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cdefou_vivant' ORDER BY ordinal_position
    `);
    const cvCols = (metaResult.rows as { column_name: string }[]).map(r => r.column_name);
    console.log("[pg-ff] cdefou_vivant colonnes:", cvCols.join(", "));

    // Cherche la colonne quantité (qte, quantite, qte_cde, qte_commandee...)
    const qtecol = cvCols.find(c => /^qte/i.test(c) || /^quantit/i.test(c));
    if (!qtecol) {
        console.warn("[pg-ff] cdefou_vivant: aucune colonne quantité trouvée →", cvCols.join(", "));
        return new Map();
    }
    console.log(`[pg-ff] cdefou_vivant: utilisation colonne "${qtecol}"`);

    const result = await db.execute(sql`
        SELECT
            a.codein,
            SUM(cv.${sql.raw(qtecol)})::float AS qtecde
        FROM cdefou_vivant cv
        JOIN artfou1 af
            ON af.no_id = cv.artfou1_no_id AND af.code = ${codefou}
        JOIN articles a
            ON a.no_id = af.art_no_id
        GROUP BY a.codein
    `);

    const map = new Map<string, number>();
    for (const row of result.rows as unknown as { codein: string; qtecde: number }[]) {
        if (row.codein) map.set(row.codein, Number(row.qtecde) || 0);
    }
    return map;
}
