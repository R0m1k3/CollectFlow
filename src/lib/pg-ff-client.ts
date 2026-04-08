/**
 * CollectFlow — Client PostgreSQL FF Nancy
 *
 * Remplace les appels HTTP per-article vers api.ffnancy.fr par des requêtes
 * SQL bulk directes sur la base PostgreSQL FF Nancy.
 *
 * Chaque fonction fait 1 seule requête filtrée par codefou — O(1) au lieu de O(N).
 */

import { db } from "@/db";
import { sql, type SQL } from "drizzle-orm";

// Cache module-level pour éviter les requêtes information_schema répétées
let _nomenclatureParentCol: string | null | undefined = undefined; // undefined = pas encore chargé

// ---------------------------------------------------------------------------
// Utilitaire : exécuter une requête sans workers parallèles PostgreSQL.
// Les workers parallèles consomment /dev/shm (mémoire partagée Docker) et font
// échouer les requêtes si le conteneur a un shm_size insuffisant.
// SET LOCAL s'applique uniquement à la transaction courante.
// ---------------------------------------------------------------------------
async function pgNoParallel(query: SQL): Promise<{ rows: unknown[] }> {
    let rows: unknown[] = [];
    await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
        const r = await tx.execute(query);
        rows = r.rows;
    });
    return { rows };
}

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
    gtin?: string;              // art_gtin.gtin (préférentiel)
    pv_central?: number;        // article_infosup.prix_vente_mini
    pa?: number;                // cube_pa.pa
    codefou_principal?: string; // artfou1.code où preference=1
    nomfou_principal?: string;  // nom du fournisseur principal
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
 * Retourne la liste des fournisseurs depuis fouident (vrais noms) + artfou1.
 */
export async function pgGetFournisseurs(search?: string): Promise<{ code: string; nom: string }[]> {
    try {
        const result = await db.execute(sql`
            SELECT DISTINCT fi.code, fi.nom
            FROM fouident fi
            INNER JOIN artfou1 af ON af.code = fi.code
            WHERE fi.nom IS NOT NULL
              AND fi.nom != ''
              ${search ? sql`AND (fi.nom ILIKE ${'%' + search + '%'} OR fi.code ILIKE ${'%' + search + '%'})` : sql``}
            ORDER BY fi.nom
        `);
        console.log(`[pg-ff] pgGetFournisseurs: ${result.rows.length} fournisseurs`);
        return (result.rows as unknown as { code: string; nom: string }[]).filter(r => r.code && r.nom);
    } catch (e) {
        console.error("[pg-ff] pgGetFournisseurs error:", (e as Error).message?.slice(0, 200));
        return [];
    }
}

// ---------------------------------------------------------------------------
// 1. Articles du fournisseur
// ---------------------------------------------------------------------------

/**
 * Retourne tous les articles d'un fournisseur avec leurs métadonnées.
 * 1 seule requête SQL — remplace getArticlesByFournisseur() + per-article fetches.
 */
export async function pgGetArticlesByFournisseur(codefou: string): Promise<PgArticle[]> {
    // DISTINCT ON (a.no_id) car artfou1 peut avoir plusieurs lignes par article/fournisseur.
    // Pas de filtre "actif" : on retourne tous les articles pour ne pas exclure les articles
    // d'une session précédente (snapshot) qui n'ont pas de gamme DB ni de ventes récentes.
    // Le filtrage gamme-Y sans ventes est fait en aval dans getProductRows (Phase 10).
    // afpref : fournisseur préférentiel (preference=1) de l'article — peut différer du fournisseur consulté.
    const result = await pgNoParallel(sql`
        SELECT DISTINCT ON (a.no_id)
            a.no_id,
            a.codein,
            af.code                     AS codefou,
            fi.nom                      AS nomfou,
            a.libelle1,
            af.pcb,
            af.reference,
            af.ean13,
            COALESCE(ag.gtin, af.ean13) AS gtin,
            ai.prix_vente_mini          AS pv_central,
            pa.pa,
            last_fournisseur.codefou_dernier AS codefou_principal,
            last_fournisseur.nomfou_dernier  AS nomfou_principal
        FROM artfou1 af
        JOIN articles a ON a.no_id = af.art_no_id
        LEFT JOIN fouident fi ON fi.code = af.code
        LEFT JOIN article_infosup ai ON ai.artnoid = a.no_id
        LEFT JOIN cube_pa pa ON pa.artnoid = a.no_id
        LEFT JOIN art_gtin ag ON ag.idarticle = a.no_id AND ag.preferentiel = 1
        LEFT JOIN LATERAL (
            SELECT af2.code AS codefou_dernier, fi2.nom AS nomfou_dernier
            FROM artfou1 af2
            LEFT JOIN fouident fi2 ON fi2.code = af2.code
            WHERE af2.art_no_id = a.no_id
            ORDER BY af2.no_id DESC
            LIMIT 1
        ) last_fournisseur ON true
        WHERE af.code = ${codefou}
          AND a.codein IS NOT NULL
          AND (af.suspendu IS NULL OR af.suspendu::text NOT IN ('1', 'true', 't', 'yes', 'y', 'on'))
          AND (a.suspendu IS NULL OR a.suspendu::text NOT IN ('1', 'true', 't', 'yes', 'y', 'on'))
        ORDER BY a.no_id, af.no_id
    `);

    console.log(`[pg-ff] Articles: ${result.rows.length} pour ${codefou}`);
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
    //
    // stock_fin_mois = qtestock du DERNIER mouvement du mois (tri par datmvt DESC).
    // MAX(qtestock) donnait le stock de début de mois (avant les premières ventes), ce qui était faux.
    const result = await pgNoParallel(sql`
        WITH base AS (
            SELECT
                a.codein,
                m.site,
                TO_CHAR(m.datmvt, 'YYYY-MM')  AS mois,
                m.qtemvt,
                m.mntmvtttc,
                m.margemvt,
                m.genremvt,
                m.qtestock,
                ROW_NUMBER() OVER (
                    PARTITION BY a.codein, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
                    ORDER BY m.datmvt DESC
                ) AS rn_last
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN (SELECT DISTINCT art_no_id FROM artfou1 WHERE code = ${codefou}) af
                ON af.art_no_id = a.no_id
            WHERE m.datmvt BETWEEN ${dateDebut}::date AND ${dateFin}::date
              AND m.site IN ('292', '579')
        )
        SELECT
            codein,
            site,
            mois,
            SUM(CASE WHEN genremvt = 3 THEN -qtemvt    ELSE 0 END)::float           AS qte_vendue,
            SUM(CASE WHEN genremvt = 3 THEN -mntmvtttc ELSE 0 END)::float           AS ca_ht,
            SUM(CASE WHEN genremvt = 3 THEN  margemvt  ELSE 0 END)::float           AS marge,
            MAX(CASE WHEN rn_last = 1 THEN qtestock ELSE NULL END)::float            AS stock_fin_mois,
            SUM(CASE WHEN genremvt IN (1, 2) THEN  qtemvt ELSE 0 END)::float        AS qte_recue
        FROM base
        GROUP BY codein, site, mois
        ORDER BY codein, site, mois
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
    const result = await pgNoParallel(sql`
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
            SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = 'nomenclature' ORDER BY ordinal_position
        `);
        const nomCols = (metaResult.rows as { column_name: string; data_type: string }[]);
        console.log("[pg-ff] Nomenclature colonnes:", nomCols.map(r => `${r.column_name}(${r.data_type})`).join(", "));
        // Cherche une colonne "parent" qui soit un entier (FK vers no_id du parent)
        // "chemin_pere" = chemin vers le père en français
        // On vérifie le data_type : integer/bigint/smallint uniquement (pas text/varchar qui serait un chemin matérialisé)
        const parentRow = nomCols.find(r =>
            (/parent|pere|father/i.test(r.column_name) || (r.column_name !== "no_id" && /no_id$/i.test(r.column_name)))
            && /int|serial/i.test(r.data_type)
        );
        _nomenclatureParentCol = parentRow?.column_name ?? null;
        console.log("[pg-ff] Nomenclature parentCol:", _nomenclatureParentCol);
    }
    const parentCol = _nomenclatureParentCol;

    let result;
    if (parentCol) {
        result = await pgNoParallel(sql`
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
        result = await pgNoParallel(sql`
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
    const result = await pgNoParallel(sql`
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
        pgNoParallel(sql`
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
            ORDER BY a.codein,
                CASE
                    WHEN r.site IN ('000', 'ALL', 'TOTAL', 'NET', 'RES') THEN 0
                    ELSE 1
                END,
                r.site
        `),
        pgNoParallel(sql`
            SELECT COUNT(DISTINCT gencod)::int AS total FROM ranking
        `),
        pgNoParallel(sql`
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
    const result = await pgNoParallel(sql`
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

// ---------------------------------------------------------------------------
// 7. Dashboard quotidien (hit parade + évolution N/N-1)
// ---------------------------------------------------------------------------

export interface DashboardSiteStats {
    site: string;
    ca_hier: number;
    ca_n1: number;
    tickets_hier: number;
    tickets_n1: number;
    qte_hier: number;
    marge_hier: number;
    lignes_hier: number;
}

export interface DashboardTopItem {
    codein: string;
    libelle1: string;
    ca: number;
    qte: number;
    marge: number;
}

export interface DashboardSiteTop10 {
    site: string;
    ca: DashboardTopItem[];
    qte: DashboardTopItem[];
    marge: DashboardTopItem[];
}

export interface DashboardData {
    dateHier: string;
    dateN1: string;
    sites: DashboardSiteStats[];
    top10BySite: DashboardSiteTop10[];
}

// ---------------------------------------------------------------------------
// Types internes API performance
// ---------------------------------------------------------------------------

interface ApiPerfSite {
    site: string;
    ca_ttc: number;
    ca_ttc_n1: number;
    trafic: number;
    trafic_n1: number;
}

interface ApiPerfTopItem {
    codein: string;
    libelle1: string;
    site: string;
    ca_ttc: number;
    qte_vendue: number;
    marge: number;
}

interface ApiPerfDashboard {
    date: string;
    date_n1: string;
    sites: ApiPerfSite[];
    top10_ca: ApiPerfTopItem[];
    top10_qte: ApiPerfTopItem[];
    top10_marge: ApiPerfTopItem[];
}

/**
 * Retourne toutes les données nécessaires pour le dashboard quotidien.
 * 100% via l'API REST api.ffnancy.fr — aucune requête PostgreSQL directe.
 * N-1 : même jour de semaine (52 semaines = 364 jours avant hier).
 */
export async function pgGetDashboardData(): Promise<DashboardData> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateHier = yesterday.toISOString().split("T")[0];

    // N-1 : même jour de semaine, même semaine N-1 → 364 jours = 52 semaines exactes
    const n1Date = new Date(yesterday);
    n1Date.setDate(n1Date.getDate() - 364);
    const dateN1Param = n1Date.toISOString().split("T")[0];

    const apiBase = "https://api.ffnancy.fr/api/performance";

    // Deux appels parallèles : données hier + données même jour N-1
    const [apiResult, apiN1Result] = await Promise.all([
        fetch(`${apiBase}/dashboard?date=${dateHier}`, { cache: "no-store" })
            .then(r => { if (!r.ok) throw new Error(`API dashboard ${r.status}: ${r.statusText}`); return r.json() as Promise<ApiPerfDashboard>; }),
        fetch(`${apiBase}/dashboard?date=${dateN1Param}`, { cache: "no-store" })
            .then(r => r.ok ? r.json() as Promise<ApiPerfDashboard> : null)
            .catch(() => null),
    ]);

    // Construire map N-1 par site depuis l'appel séparé
    const n1BySite = new Map<string, { ca: number; trafic: number }>();
    for (const s of apiN1Result?.sites ?? []) {
        n1BySite.set(s.site, { ca: Number(s.ca_ttc) || 0, trafic: Number(s.trafic) || 0 });
    }

    const sites: DashboardSiteStats[] = (apiResult.sites ?? []).map(s => {
        const n1 = n1BySite.get(s.site);
        // Priorité : même jour de semaine N-1 (si > 0), sinon fallback sur n1 calendaire de l'API
        const caN1 = (n1?.ca && n1.ca > 0) ? n1.ca : (Number(s.ca_ttc_n1) || 0);
        const trafficN1 = (n1?.trafic && n1.trafic > 0) ? n1.trafic : (Number(s.trafic_n1) || 0);
        return {
            site: s.site,
            ca_hier: Number(s.ca_ttc) || 0,
            ca_n1: caN1,
            tickets_hier: Number(s.trafic) || 0,
            tickets_n1: trafficN1,
            qte_hier: 0,
            marge_hier: 0,
            lignes_hier: 0,
        };
    });

    // Top 10 par magasin : grouper les items par site, trier, garder top 10
    const buildTop10 = (items: ApiPerfTopItem[], sortKey: "ca" | "qte" | "marge"): DashboardTopItem[] =>
        items
            .map(i => ({
                codein: i.codein,
                libelle1: i.libelle1,
                ca: Number(i.ca_ttc) || 0,
                qte: Number(i.qte_vendue) || 0,
                marge: Number(i.marge) || 0,
            }))
            .sort((a, b) => b[sortKey] - a[sortKey])
            .slice(0, 10);

    const allItems = [
        ...(apiResult.top10_ca ?? []),
        ...(apiResult.top10_qte ?? []),
        ...(apiResult.top10_marge ?? []),
    ];
    const siteSet = [...new Set(allItems.map(i => i.site).filter(Boolean))].sort();

    const top10BySite: DashboardSiteTop10[] = siteSet.map(site => {
        const byS = (arr: ApiPerfTopItem[]) => arr.filter(i => i.site === site);
        return {
            site,
            ca: buildTop10(byS(apiResult.top10_ca ?? []), "ca"),
            qte: buildTop10(byS(apiResult.top10_qte ?? []), "qte"),
            marge: buildTop10(byS(apiResult.top10_marge ?? []), "marge"),
        };
    });

    console.log(`[pg-ff] Dashboard: hier=${dateHier} n1=${dateN1Param} sites=${sites.length} n1_found=${n1BySite.size}`);

    return {
        dateHier: apiResult.date ?? dateHier,
        dateN1: apiN1Result?.date ?? dateN1Param,
        sites,
        top10BySite,
    };
}

// ---------------------------------------------------------------------------
// Analytics — CA TTC par fournisseur et nomenclature
// ---------------------------------------------------------------------------

export interface CaByFournisseurRow {
    code: string;
    nom: string;
    site: string;
    mois: string;
    ca_ttc: number;
}

export interface CaByNomenclatureRow {
    code: string;
    libelle: string;
    site: string;
    mois: string;
    ca_ttc: number;
}

/**
 * Retourne le CA TTC par fournisseur et site pour deux mois donnés (mois et mois N-1).
 * Attribution via artfou1.preference = true (fournisseur principal de l'article).
 */
export async function pgGetCaByFournisseur(
    mois: string,
    moisN1: string
): Promise<CaByFournisseurRow[]> {
    const result = await pgNoParallel(sql`
        SELECT
            COALESCE(af.code, 'SANS_FOURNISSEUR')::text              AS code,
            COALESCE(fi.nom, af.code, 'Sans fournisseur')::text       AS nom,
            m.site,
            TO_CHAR(m.datmvt, 'YYYY-MM')                             AS mois,
            ABS(SUM(m.mntmvtttc))::float                             AS ca_ttc
        FROM mvtart m
        JOIN articles a   ON a.no_id        = m.artnoid
        LEFT JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
        LEFT JOIN fouident fi ON fi.code     = af.code
        WHERE (TO_CHAR(m.datmvt, 'YYYY-MM') = ${mois} OR TO_CHAR(m.datmvt, 'YYYY-MM') = ${moisN1})
          AND m.site IN ('292', '579')
          AND m.genremvt = 3
        GROUP BY af.code, fi.nom, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
        ORDER BY af.code, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
    `);

    console.log(`[pg-ff] CaByFournisseur: ${result.rows.length} lignes pour ${mois}/${moisN1}`);
    return result.rows as unknown as CaByFournisseurRow[];
}

/**
 * Retourne le CA TTC par nomenclature et site pour deux mois donnés.
 */
export async function pgGetCaByNomenclature(
    mois: string,
    moisN1: string
): Promise<CaByNomenclatureRow[]> {
    const result = await pgNoParallel(sql`
        SELECT
            COALESCE(n.code, 'SANS_NOM')::text      AS code,
            COALESCE(n.libelle, 'Sans nomenclature')::text AS libelle,
            m.site,
            TO_CHAR(m.datmvt, 'YYYY-MM')            AS mois,
            ABS(SUM(m.mntmvtttc))::float             AS ca_ttc
        FROM mvtart m
        JOIN articles      a ON a.no_id    = m.artnoid
        LEFT JOIN nomenclature n ON n.no_id = a.nom_no_id
        WHERE (TO_CHAR(m.datmvt, 'YYYY-MM') = ${mois} OR TO_CHAR(m.datmvt, 'YYYY-MM') = ${moisN1})
          AND m.site IN ('292', '579')
          AND m.genremvt = 3
        GROUP BY n.no_id, n.code, n.libelle, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
        ORDER BY n.code, m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
    `);

    console.log(`[pg-ff] CaByNomenclature: ${result.rows.length} lignes pour ${mois}/${moisN1}`);
    return result.rows as unknown as CaByNomenclatureRow[];
}

// ---------------------------------------------------------------------------
// Hit Parade — produits les plus vendus sur un mois donné
// ---------------------------------------------------------------------------

export interface HitParadeRow {
    codein: string;
    libelle: string;
    fournisseur: string;
    nomenclature_code: string;
    nomenclature: string;
    site: string;
    qte_vendue: number;
    ca_ttc: number;
    marge: number;
    stock292: number;
    stock579: number;
    stockTotal: number;
}

/**
 * Retourne les ventes produit sur une période, avec fournisseur, qté, CA TTC, marge et stock par site.
 * Le stock est intégré via un LEFT JOIN — pas de requête séparée, pas de tableau de paramètres.
 */
export async function pgGetHitParade(dateDebut: string, dateFin: string): Promise<HitParadeRow[]> {
    const result = await pgNoParallel(sql`
        WITH ventes AS (
            SELECT
                a.no_id                                                         AS art_no_id,
                a.codein::text                                                  AS codein,
                a.libelle1::text                                                AS libelle,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text             AS fournisseur,
                COALESCE(n.code, '')::text                                      AS nomenclature_code,
                COALESCE(n.libelle, 'Sans nomenclature')::text                  AS nomenclature,
                m.site,
                SUM(ABS(m.qtemvt))::float                                      AS qte_vendue,
                ABS(SUM(m.mntmvtttc))::float                                   AS ca_ttc,
                SUM(m.margemvt)::float                                          AS marge
            FROM mvtart m
            JOIN articles a      ON a.no_id        = m.artnoid
            LEFT JOIN artfou1 af ON af.art_no_id   = a.no_id AND af.preference = 1
            LEFT JOIN fouident fi ON fi.code        = af.code
            LEFT JOIN nomenclature n ON n.no_id     = a.nom_no_id
            WHERE m.datmvt BETWEEN ${dateDebut}::date AND ${dateFin}::date
              AND m.site IN ('292', '579')
              AND m.genremvt = 3
            GROUP BY a.no_id, a.codein, a.libelle1, fi.nom, af.code, n.code, n.libelle, m.site
        ),
        stock_agg AS (
            SELECT
                cs.artnoid,
                SUM(CASE WHEN cs.site = '292' THEN cs.qte ELSE 0 END)::float AS stock292,
                SUM(CASE WHEN cs.site = '579' THEN cs.qte ELSE 0 END)::float AS stock579,
                SUM(cs.qte)::float                                            AS stockTotal
            FROM cube_stock cs
            WHERE cs.artnoid IN (SELECT DISTINCT art_no_id FROM ventes)
            GROUP BY cs.artnoid
        )
        SELECT
            v.codein,
            v.libelle,
            v.fournisseur,
            v.nomenclature_code,
            v.nomenclature,
            v.site,
            v.qte_vendue,
            v.ca_ttc,
            v.marge,
            COALESCE(s.stock292, 0)    AS stock292,
            COALESCE(s.stock579, 0)    AS stock579,
            COALESCE(s.stockTotal, 0)  AS "stockTotal"
        FROM ventes v
        LEFT JOIN stock_agg s ON s.artnoid = v.art_no_id
        ORDER BY v.ca_ttc DESC
    `);

    console.log(`[pg-ff] HitParade: ${result.rows.length} lignes pour ${dateDebut}→${dateFin}`);
    return result.rows as unknown as HitParadeRow[];
}

// ---------------------------------------------------------------------------
// Stock par liste de codeins (pour Hit Parade)
// ---------------------------------------------------------------------------

export interface StockBySite {
    stock292: number;
    stock579: number;
    stockTotal: number;
}

/**
 * Retourne le stock actuel (stockdispo) par codein pour une liste de codeins.
 * 1 seule requête bulk — utilisé pour enrichir le Hit Parade.
 *
 * On passe les codeins comme une SEULE chaîne CSV ($1) et on utilise
 * string_to_array côté PG — cela évite l'expansion Drizzle en $1,$2,...$N
 * qui déclencherait le PG error 54011 (ROW > 1664 entries).
 */
export async function pgGetStockForCodeins(codeins: string[]): Promise<Map<string, StockBySite>> {
    if (codeins.length === 0) return new Map();

    const codeinsStr = codeins.join(",");
    const result = await pgNoParallel(
        sql`SELECT a.codein, cs.site, cs.stockdispo::float AS stockdispo
            FROM cube_stock cs
            JOIN articles a ON a.no_id = cs.artnoid
            WHERE a.codein = ANY(string_to_array(${codeinsStr}, ','))`
    );
    const rows = result.rows as { codein: string; site: string; stockdispo: number }[];

    const map = new Map<string, StockBySite>();
    for (const r of rows) {
        if (!map.has(r.codein)) map.set(r.codein, { stock292: 0, stock579: 0, stockTotal: 0 });
        const entry = map.get(r.codein)!;
        if (r.site === "292") entry.stock292 += r.stockdispo;
        else if (r.site === "579") entry.stock579 += r.stockdispo;
        entry.stockTotal += r.stockdispo;
    }
    return map;
}

// ---------------------------------------------------------------------------
// Stock négatif — tous magasins ou par site
// ---------------------------------------------------------------------------

export interface PgStockNegatifRow {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
    stockdispo: number;
    dernierevente: string | null;
    derniereentree: string | null;
}

/**
 * Retourne tous les articles avec un stock disponible négatif.
 * Si `site` est fourni, filtre sur ce magasin uniquement.
 */
export interface PgStockSansVenteRow {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
    stock_actuel: number;
    derniere_entree: string | null;
}

/**
 * Retourne les articles ayant des entrées en stock (hors mois courant)
 * mais aucune vente enregistrée sur ce site.
 */
export async function pgGetStockSansVente(site?: string): Promise<PgStockSansVenteRow[]> {
    const siteFilter = site ? sql`AND m.site = ${site}` : sql``;
    const result = await pgNoParallel(sql`
        SELECT
            a.codein,
            COALESCE(a.libelle1, '') AS libelle1,
            COALESCE(f.nom, af.code) AS fournisseur,
            m.site,
            COALESCE(cs.qte::float, 0) AS stock_actuel,
            MAX(m.datmvt)::text AS derniere_entree
        FROM mvtart m
        JOIN articles a ON a.no_id = m.artnoid
        JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
        JOIN fouident f ON f.code = af.code
        LEFT JOIN cube_stock cs ON cs.artnoid = a.no_id AND cs.site = m.site
        WHERE m.genremvt IN (1, 2)
          AND m.site IN ('292', '579')
          AND date_trunc('month', m.datmvt) < date_trunc('month', CURRENT_DATE)
          ${siteFilter}
          AND NOT EXISTS (
              SELECT 1 FROM mvtart mv2
              WHERE mv2.artnoid = m.artnoid
                AND mv2.site = m.site
                AND mv2.genremvt = 3
          )
        GROUP BY a.codein, a.libelle1, f.nom, af.code, m.site, cs.qte
        ORDER BY MAX(m.datmvt) DESC
    `);
    return result.rows as PgStockSansVenteRow[];
}

export async function pgGetStockNegatif(site?: string): Promise<PgStockNegatifRow[]> {
    const siteFilter = site ? sql`AND cs.site = ${site}` : sql``;
    const result = await pgNoParallel(sql`
        SELECT
            a.codein,
            COALESCE(a.libelle1, '') AS libelle1,
            COALESCE(f.nom, af.code) AS fournisseur,
            cs.site,
            cs.qte::float AS stockdispo,
            cs.dernierevente::text,
            (
                SELECT MAX(m.datmvt)::text
                FROM mvtart m
                WHERE m.artnoid = cs.artnoid
                  AND m.site = cs.site
                  AND m.genremvt IN (1, 2)
            ) AS derniereentree
        FROM cube_stock cs
        JOIN articles a ON a.no_id = cs.artnoid
        JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
        JOIN fouident f ON f.code = af.code
        WHERE cs.qte < 0
          AND cs.site IN ('292', '579')
        ${siteFilter}
        ORDER BY cs.stockdispo ASC
    `);
    return result.rows as PgStockNegatifRow[];
}

// ---------------------------------------------------------------------------
// Commandes automatiques — par site + fournisseur avec franco
// ---------------------------------------------------------------------------

export interface PgCommandeAutoRow {
    site: string;
    codefou: string;
    nomfou: string;
    franco: number;
    nb_articles: number;
    montant_cde: number;
    franco_atteint: boolean | null;
    ecart_franco: number;
}

/**
 * Retourne la liste des fournisseurs ayant des articles en commande auto,
 * groupés par site + fournisseur, avec le montant total (pcb × pa),
 * le franco du fournisseur et l'écart franco.
 *
 * Hypothèses sur le schéma FF Nancy :
 *   - artfou1.cdeauto  : flag commande auto (boolean-like)
 *   - fouident.franco  : franco de port (montant minimum de commande)
 *   - cube_pa.pa       : prix d'achat
 */
export async function pgGetCommandesAuto(): Promise<PgCommandeAutoRow[]> {
    try {
        const result = await pgNoParallel(sql`
            SELECT
                cs.site,
                fi.code                                     AS codefou,
                COALESCE(fi.nom, af.code)                   AS nomfou,
                COALESCE(fi.franco::numeric, 0)             AS franco,
                COUNT(DISTINCT a.codein)                    AS nb_articles,
                ROUND(SUM(
                    GREATEST(1, COALESCE(af.pcb, 1))::numeric
                    * COALESCE(pa.pa, 0)::numeric
                ), 2)                                       AS montant_cde,
                CASE
                    WHEN COALESCE(fi.franco::numeric, 0) = 0 THEN NULL
                    WHEN SUM(
                        GREATEST(1, COALESCE(af.pcb, 1))::numeric
                        * COALESCE(pa.pa, 0)::numeric
                    ) >= COALESCE(fi.franco::numeric, 0)    THEN true
                    ELSE false
                END                                         AS franco_atteint,
                ROUND(
                    COALESCE(fi.franco::numeric, 0) - SUM(
                        GREATEST(1, COALESCE(af.pcb, 1))::numeric
                        * COALESCE(pa.pa, 0)::numeric
                    ), 2
                )                                           AS ecart_franco
            FROM artfou1 af
            JOIN articles a  ON a.no_id   = af.art_no_id
            JOIN fouident fi ON fi.code   = af.code
            JOIN cube_stock cs ON cs.artnoid = a.no_id
            LEFT JOIN cube_pa pa ON pa.artnoid = a.no_id
            WHERE af.cdeauto::text IN ('1', 'true', 't', 'yes', 'y', 'on')
              AND cs.site IN ('292', '579')
              AND (af.suspendu IS NULL OR af.suspendu::text NOT IN ('1', 'true', 't', 'yes', 'y', 'on'))
              AND (a.suspendu  IS NULL OR a.suspendu::text  NOT IN ('1', 'true', 't', 'yes', 'y', 'on'))
            GROUP BY cs.site, fi.code, fi.nom, af.code, fi.franco
            ORDER BY cs.site, COALESCE(fi.nom, af.code)
        `);
        console.log(`[pg-ff] pgGetCommandesAuto: ${result.rows.length} lignes`);
        return result.rows as unknown as PgCommandeAutoRow[];
    } catch (e) {
        console.error("[pg-ff] pgGetCommandesAuto error:", (e as Error).message?.slice(0, 300));
        return [];
    }
}
