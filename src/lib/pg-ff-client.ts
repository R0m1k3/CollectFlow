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

const FF_API_BASE = process.env.FF_API_BASE_URL ?? "https://api.ffnancy.fr";


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
    /** Code centrale = articles.artcentrale (format 10000XXXXXX) — clé jointure Qlik "Article Code". Vide pour les articles non référencés centralement. */
    codeCentrale?: string;
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
            a.artcentrale               AS "codeCentrale",
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

/** Article local (FF Nancy) résolu depuis un code centrale — page Recherche réseau. */
export interface PgArticleLocal {
    codein: string;
    codeCentrale: string;
    libelle1?: string;
    codefou?: string;
    nomfou?: string;
    pa?: number;
    pv_central?: number;
}

/**
 * Résout des codes centraux vers NOS articles locaux.
 *
 * Sert à distinguer, dans les résultats de recherche Qlik, les produits que nous
 * référençons (« Chez moi ») de ceux qui n'existent que dans le réseau. Un code
 * absent de la Map = produit inconnu de FF Nancy.
 */
export async function pgGetArticlesByCodeCentrale(codes: string[]): Promise<Map<string, PgArticleLocal>> {
    const unique = [...new Set(codes.map(c => String(c ?? "").trim()).filter(Boolean))];
    if (unique.length === 0) return new Map();

    const result = await pgNoParallel(sql`
        SELECT DISTINCT ON (a.artcentrale)
            TRIM(a.codein::text) AS codein,
            a.artcentrale        AS "codeCentrale",
            a.libelle1,
            af.code              AS codefou,
            fi.nom               AS nomfou,
            pa.pa,
            ai.prix_vente_mini   AS pv_central
        FROM articles a
        LEFT JOIN artfou1 af ON af.art_no_id = a.no_id
        LEFT JOIN fouident fi ON fi.code = af.code
        LEFT JOIN cube_pa pa ON pa.artnoid = a.no_id
        LEFT JOIN article_infosup ai ON ai.artnoid = a.no_id
        WHERE TRIM(a.artcentrale::text) IN (${sql.join(unique.map(c => sql`${c}`), sql`, `)})
          AND a.codein IS NOT NULL
        ORDER BY a.artcentrale, af.no_id
    `);

    const map = new Map<string, PgArticleLocal>();
    for (const r of result.rows as unknown as PgArticleLocal[]) {
        if (r.codeCentrale) map.set(String(r.codeCentrale).trim(), r);
    }
    console.log(`[pg-ff] pgGetArticlesByCodeCentrale: ${map.size}/${unique.length} codes connus localement`);
    return map;
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

/**
 * Gammes **serveur** pour une liste de codein, tous fournisseurs confondus.
 *
 * Variante de `pgGetGammesByFournisseur` sans la jointure `artfou1` : la recherche
 * de l'API `/api/v1` est transversale, on ne connaît donc pas le fournisseur.
 * C'est la gamme telle qu'elle existe en base — non modifiée, indépendante des
 * snapshots de session qui peuvent surcharger `codeGamme` dans la Grille.
 */
export async function pgGetGammesByCodeins(codeins: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(codeins.map(c => String(c ?? "").trim()).filter(Boolean))];
    if (unique.length === 0) return new Map();

    // Découpage obligatoire : chaque codein devient un paramètre lié, or PostgreSQL
    // en accepte 65535 au maximum. Un gros fournisseur dépasse 130 000 articles —
    // la requête échouait alors purement et simplement.
    const CHUNK = 2000;
    const map = new Map<string, string>();

    for (let i = 0; i < unique.length; i += CHUNK) {
        const batch = unique.slice(i, i + CHUNK);
        // DISTINCT ON (codein) → 1 gamme par article, saison la plus récente en premier.
        const result = await pgNoParallel(sql`
            SELECT DISTINCT ON (a.codein)
                TRIM(a.codein::text) AS codein,
                g.code AS gamme_code
            FROM art_gamme_saison ags
            JOIN articles a ON a.no_id = ags.artnoid
            JOIN gammes g   ON g.no_id = ags.idgamme
            JOIN saisons s  ON s.no_id = ags.idsaison
            WHERE TRIM(a.codein::text) IN (${sql.join(batch.map(c => sql`${c}`), sql`, `)})
            ORDER BY a.codein, s.no_id DESC
        `);
        for (const row of result.rows as unknown as { codein: string; gamme_code: string }[]) {
            if (row.codein && row.gamme_code) map.set(row.codein, String(row.gamme_code).trim());
        }
    }
    console.log(`[pg-ff] pgGetGammesByCodeins: ${map.size}/${unique.length} articles avec gamme`);
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
/**
 * Découvre (une seule fois par process) le nom de la colonne "parent" de la
 * table `nomenclature`, qui porte la FK vers le `no_id` du niveau supérieur.
 *
 * On ne peut pas la coder en dur : le nom varie selon les installations
 * ("chemin_pere" existe mais c'est un chemin *texte* matérialisé, pas la FK),
 * d'où le filtre explicite sur `data_type` entier.
 */
async function getNomenclatureParentCol(): Promise<string | null> {
    if (_nomenclatureParentCol !== undefined) return _nomenclatureParentCol;

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
    return _nomenclatureParentCol;
}

export async function pgGetNomenclatureByFournisseur(codefou: string): Promise<Map<string, PgNomRow>> {
    const parentCol = await getNomenclatureParentCol();

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
    stock: number;
    fournisseur: string;
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
    codefou_reel?: string;
    nom_fournisseur_reel?: string;
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

    const apiBase = `${FF_API_BASE}/api/performance`;


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
    const allItems = [
        ...(apiResult.top10_ca ?? []),
        ...(apiResult.top10_qte ?? []),
        ...(apiResult.top10_marge ?? []),
    ];
    const allCodeins = [...new Set(allItems.map(i => i.codein).filter(Boolean))];

    // Fournisseur réel : un seul appel sur les mouvements du jour (codefou_reel / nom_fournisseur_reel).
    // Enrichissement : fournisseur réel via /dernier-fournisseur (primaire) + /referentiel (stock + fallback fournisseur).
    // Les deux appels sont faits en parallèle par article.
    const fouMap = new Map<string, string>(); // codein → nom_fournisseur résolu
    const stockMap = new Map<string, { stock292: number; stock579: number; stockTotal: number }>();


    if (allCodeins.length > 0) {
        try {
            for (let i = 0; i < allCodeins.length; i += 5) {
                const batch = allCodeins.slice(i, i + 5);
                await Promise.all(batch.map(async (codein) => {
                    try {
                        const artRes = await fetch(`${FF_API_BASE}/api/articles?codein=${encodeURIComponent(codein)}`);
                        if (!artRes.ok) return;
                        const artData = await artRes.json();
                        if (!artData.articles || artData.articles.length === 0) return;

                        const noId = artData.articles[0].no_id;
                        if (!noId) return;

                        const [refRes, dernierRes] = await Promise.all([
                            fetch(`${FF_API_BASE}/api/articles/${encodeURIComponent(noId)}/referentiel`),
                            fetch(`${FF_API_BASE}/api/articles/${encodeURIComponent(noId)}/dernier-fournisseur`),
                        ]);

                        // Stock (toujours depuis referentiel)
                        let refFournisseurFallback = "";
                        if (refRes.ok) {
                            const refData = await refRes.json();
                            let s292 = 0, s579 = 0, sTot = 0;
                            if (Array.isArray(refData.stock)) {
                                for (const s of refData.stock) {
                                    const qte = Number(s.qte) || 0;
                                    if (s.site === '292') s292 += qte;
                                    else if (s.site === '579') s579 += qte;
                                    sTot += qte;
                                }
                            }
                            stockMap.set(codein, { stock292: s292, stock579: s579, stockTotal: sTot });

                            // Fallback fournisseur (pas d'entrée en stock) :
                            // - 1 seul fournisseur → on l'utilise directement
                            // - plusieurs → celui avec preference = 1
                            if (Array.isArray(refData.fournisseurs) && refData.fournisseurs.length > 0) {
                                type RefFou = { codefou: string; nom_fou: string | null; preference: number | null };
                                const fous = refData.fournisseurs as RefFou[];
                                const pick = fous.length === 1
                                    ? fous[0]
                                    : (fous.find(f => f.preference === 1) ?? fous[0]);
                                refFournisseurFallback = pick.nom_fou?.trim() || pick.codefou?.trim() || "";
                            }
                        }

                        // Fournisseur réel : /dernier-fournisseur (dernière entrée en stock par site)
                        // Fallback : premier non-dépôt du référentiel
                        if (dernierRes.ok) {
                            const dernierData = await dernierRes.json();
                            const entries: Array<{ site: string; nom_fournisseur: string }> =
                                dernierData.fournisseurs_par_site ?? [];
                            // Prendre le fournisseur du premier site disponible
                            const first = entries.find(e => e.nom_fournisseur);
                            if (first) {
                                fouMap.set(codein, String(first.nom_fournisseur).trim());
                            } else if (refFournisseurFallback) {
                                fouMap.set(codein, refFournisseurFallback);
                            }
                        } else if (refFournisseurFallback) {
                            fouMap.set(codein, refFournisseurFallback);
                        }
                    } catch (err) {
                        console.error(`[Dashboard enrichment] Error for codein ${codein}:`, err);
                    }
                }));
            }
        } catch (enrichErr: unknown) {
            console.warn("[Dashboard] Enrichment unavailable:", enrichErr);
        }
    }

    const siteSet = [...new Set(allItems.map(i => i.site).filter(Boolean))].sort();

    const buildTop10 = (items: ApiPerfTopItem[], sortKey: "ca" | "qte" | "marge"): DashboardTopItem[] =>
        items
            .map(i => {
                const stockEntry = stockMap.get(i.codein);
                const stock = i.site === "292" ? (stockEntry?.stock292 ?? 0)
                    : i.site === "579" ? (stockEntry?.stock579 ?? 0)
                        : (stockEntry?.stockTotal ?? 0);
                const fournisseur = fouMap.get(i.codein) ?? "—";
                return {
                    codein: i.codein,
                    libelle1: i.libelle1,
                    ca: Number(i.ca_ttc) || 0,
                    qte: Number(i.qte_vendue) || 0,
                    marge: Number(i.marge) || 0,
                    stock,
                    fournisseur,
                };
            })
            .sort((a, b) => b[sortKey] - a[sortKey])
            .slice(0, 10);

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
 * CA NET : SUM(-mntmvtttc) — les retours clients sont déduits (même convention
 * que pgGetMensuelByFournisseur / pgGetHitParade). Fournisseur préféré résolu
 * via une sous-requête artfou1 dédupliquée (DISTINCT ON) : un seul code par
 * article, aucune duplication possible des mouvements dans la somme.
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
            SUM(-m.mntmvtttc)::float                                 AS ca_ttc
        FROM mvtart m
        JOIN articles a   ON a.no_id        = m.artnoid
        LEFT JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
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
 * CA NET : SUM(-mntmvtttc) — retours clients déduits (convention commune).
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
            SUM(-m.mntmvtttc)::float                 AS ca_ttc
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
 *
 * L'agrégation des ventes se fait UNIQUEMENT sur mvtart × articles (jointure 1:1),
 * exactement comme pgGetMensuelByFournisseur (le calcul canonique de la Grille) :
 * qte = SUM(-qtemvt), ca = SUM(-mntmvtttc), marge = SUM(margemvt) pour genremvt = 3
 * (ventes stockées en négatif — vérifié sur les mouvements réels de l'API).
 * Les attributs (libellé, fournisseur préféré, nomenclature) et le stock sont
 * joints APRÈS l'agrégation, par codein : aucune jointure ne peut dupliquer les
 * mouvements et fausser les sommes, et le LATERAL fournisseur ne s'exécute que
 * par article vendu (et non par ligne de mouvement).
 *
 * Cas vérifié (codein 487673, site 579, jan→juil 2026) : 31 ventes brutes,
 * 7 retours clients → 24 net. L'ancien SUM(ABS(qtemvt)) affichait 38 (retours
 * additionnés) ; SUM(-qtemvt) donne 24, identique à l'API mensuel officielle.
 */
export async function pgGetHitParade(dateDebut: string, dateFin: string): Promise<HitParadeRow[]> {
    const result = await pgNoParallel(sql`
        WITH ventes AS (
            SELECT
                TRIM(a.codein::text)                                           AS codein,
                m.site,
                SUM(-m.qtemvt)::float                                          AS qte_vendue,
                SUM(-m.mntmvtttc)::float                                       AS ca_ttc,
                SUM(m.margemvt)::float                                          AS marge
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            WHERE m.datmvt BETWEEN ${dateDebut}::date AND ${dateFin}::date
              AND m.site IN ('292', '579')
              AND m.genremvt = 3
              AND a.codein IS NOT NULL
            GROUP BY TRIM(a.codein::text), m.site
        ),
        attrs AS (
            SELECT DISTINCT ON (TRIM(a.codein::text))
                TRIM(a.codein::text)                                    AS codein,
                a.libelle1::text                                        AS libelle,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text     AS fournisseur,
                COALESCE(n.code, '')::text                              AS nomenclature_code,
                COALESCE(n.libelle, 'Sans nomenclature')::text          AS nomenclature
            FROM articles a
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = a.no_id AND af1.preference = 1
                ORDER BY af1.code
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            LEFT JOIN nomenclature n ON n.no_id = a.nom_no_id
            WHERE TRIM(a.codein::text) IN (SELECT codein FROM ventes)
            ORDER BY TRIM(a.codein::text), a.no_id DESC
        ),
        stock_agg AS (
            SELECT
                TRIM(a2.codein::text)                                         AS codein,
                SUM(CASE WHEN cs.site = '292' THEN cs.qte ELSE 0 END)::float AS stock292,
                SUM(CASE WHEN cs.site = '579' THEN cs.qte ELSE 0 END)::float AS stock579,
                SUM(cs.qte)::float                                            AS stockTotal
            FROM cube_stock cs
            JOIN articles a2 ON a2.no_id = cs.artnoid
            WHERE TRIM(a2.codein::text) IN (SELECT codein FROM ventes)
            GROUP BY TRIM(a2.codein::text)
        )
        SELECT
            v.codein,
            COALESCE(ar.libelle, '')                          AS libelle,
            COALESCE(ar.fournisseur, 'Sans fournisseur')      AS fournisseur,
            COALESCE(ar.nomenclature_code, '')                AS nomenclature_code,
            COALESCE(ar.nomenclature, 'Sans nomenclature')    AS nomenclature,
            v.site,
            v.qte_vendue,
            v.ca_ttc,
            v.marge,
            COALESCE(s.stock292, 0)    AS stock292,
            COALESCE(s.stock579, 0)    AS stock579,
            COALESCE(s.stockTotal, 0)  AS "stockTotal"
        FROM ventes v
        LEFT JOIN attrs ar     ON ar.codein = v.codein
        LEFT JOIN stock_agg s  ON s.codein  = v.codein
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

    const result = await pgNoParallel(
        sql`SELECT TRIM(a.codein::text) AS codein, cs.site, COALESCE(cs.qte, 0)::float AS stockdispo
            FROM cube_stock cs
            JOIN articles a ON a.no_id = cs.artnoid
            WHERE TRIM(a.codein::text) IN (${sql.join(codeins.map(c => sql`${c}`), sql`, `)})`
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
        JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
        JOIN fouident f ON f.code = af.code
        WHERE cs.qte < 0
          AND cs.site IN ('292', '579')
        ${siteFilter}
        ORDER BY cs.qte ASC
    `);
    return result.rows as PgStockNegatifRow[];
}

// ---------------------------------------------------------------------------
// Stock sans vente depuis 6 mois
// ---------------------------------------------------------------------------

export interface PgSansVente6MoisRow {
    codein: string;
    libelle1: string;
    fournisseur: string;
    site: string;
    stock_actuel: number;
    derniere_vente: string | null;
    derniere_entree: string | null;
    jours_sans_vente: number | null;
}

/**
 * Retourne les articles ayant du stock disponible (qte > 0)
 * dont la dernière vente remonte à plus de 6 mois (ou jamais vendus)
 * ET dont la dernière entrée en stock remonte aussi à plus de 6 mois.
 */
export async function pgGetSansVente6Mois(site?: string): Promise<PgSansVente6MoisRow[]> {
    const siteFilter = site ? sql`AND cs.site = ${site}` : sql``;
    const result = await pgNoParallel(sql`
        SELECT
            a.codein,
            COALESCE(a.libelle1, '') AS libelle1,
            COALESCE(f.nom, af.code) AS fournisseur,
            cs.site,
            cs.qte::float AS stock_actuel,
            cs.dernierevente::text AS derniere_vente,
            CASE
                WHEN cs.dernierevente IS NULL THEN NULL
                ELSE (CURRENT_DATE - cs.dernierevente::date)
            END AS jours_sans_vente,
            (
                SELECT MAX(m.datmvt)::text
                FROM mvtart m
                WHERE m.artnoid = cs.artnoid
                  AND m.site = cs.site
                  AND m.genremvt IN (1, 2)
            ) AS derniere_entree
        FROM cube_stock cs
        JOIN articles a ON a.no_id = cs.artnoid
        JOIN (
            SELECT DISTINCT ON (art_no_id) art_no_id, code
            FROM artfou1
            WHERE preference = 1
            ORDER BY art_no_id, code
        ) af ON af.art_no_id = a.no_id
        JOIN fouident f ON f.code = af.code
        WHERE cs.site IN ('292', '579')
          AND cs.qte > 0
          AND (
              cs.dernierevente IS NULL
              OR cs.dernierevente < CURRENT_DATE - INTERVAL '6 months'
          )
          AND NOT EXISTS (
              SELECT 1 FROM mvtart m2
              WHERE m2.artnoid = cs.artnoid
                AND m2.site = cs.site
                AND m2.genremvt IN (1, 2)
                AND m2.datmvt >= CURRENT_DATE - INTERVAL '6 months'
          )
          ${siteFilter}
        ORDER BY cs.dernierevente ASC NULLS FIRST
    `);
    return result.rows as PgSansVente6MoisRow[];
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapCommandeAutoRow(r: any): PgCommandeAutoRow {
    return {
        site:          String(r.site ?? ""),
        codefou:       String(r.codefou ?? ""),
        nomfou:        String(r.nom_fou ?? r.nomfou ?? ""),
        franco:        Number(r.franco_ht ?? r.franco ?? 0),
        nb_articles:   Number(r.nb_articles ?? 0),
        montant_cde:   Number(r.montant_propo_ht ?? r.montant_cde ?? 0),
        franco_atteint: r.franco_atteint === "OUI" ? true
                      : r.franco_atteint === "NON" ? false
                      : r.franco_atteint === "N/A" ? null
                      : r.franco_atteint != null ? Boolean(r.franco_atteint)
                      : null,
        ecart_franco:  Number(r.ecart_franco ?? 0),
    };
}

/**
 * Retourne la liste des fournisseurs en commande automatique via l'API Hostinger.
 * GET https://api.ffnancy.fr/api/commandes-auto
 *
 * Pour les fournisseurs dont le franco est absent de la réponse globale (franco_ht null),
 * on enrichit via le detail endpoint /api/commandes-auto/:codefou?site= qui contient
 * toujours le résumé franco du fournisseur.
 */
export async function pgGetCommandesAuto(): Promise<PgCommandeAutoRow[]> {

    try {
        const res = await fetch(`${FF_API_BASE}/api/commandes-auto`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // L'API retourne { count: N, propositions: [...] } ou un tableau direct
        const rows: unknown[] = Array.isArray(data)
            ? data
            : (data?.propositions ?? data?.data ?? data?.items ?? data?.results ?? []);

        // Diagnostic : log les clés du premier row pour détecter les changements de format
        if (rows.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sample = rows[0] as any;
            console.log(`[pg-ff] pgGetCommandesAuto sample keys:`, Object.keys(sample));
            console.log(`[pg-ff] pgGetCommandesAuto sample franco fields: franco_ht=${sample.franco_ht} franco=${sample.franco} franco_atteint=${sample.franco_atteint}`);
        }

        console.log(`[pg-ff] pgGetCommandesAuto: ${rows.length} lignes (API Hostinger)`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mapped = (rows as any[]).map(mapCommandeAutoRow);

        // Enrichissement : pour les fournisseurs sans franco dans la réponse globale,
        // on appelle GET /api/commandes-auto/{codefou} (sans filtre site — franco est une
        // propriété du fournisseur, pas du site) et on lit resume[0].franco_ht.
        const missingFranco = mapped.filter(r => r.franco === 0 && r.codefou);
        if (missingFranco.length > 0) {
            console.log(`[pg-ff] pgGetCommandesAuto: ${missingFranco.length} lignes sans franco → enrichissement`);
            // Dédupliquer par codefou (franco identique quel que soit le site)
            const uniqueCodeFous = [...new Set(missingFranco.map(r => r.codefou))];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const extractFranco = (detail: any): number => {
                if (!detail || detail.error) return 0;
                const resumeRaw = detail?.resume ?? detail?.summary ?? detail;
                const resumeItem = Array.isArray(resumeRaw) ? resumeRaw[0] : resumeRaw;
                return Number(resumeItem?.franco_ht ?? resumeItem?.franco ?? 0);
            };

            const details = await Promise.allSettled(
                uniqueCodeFous.map(async codefou => {
                    // 1. Essai sans filtre site
                    try {
                        const res2 = await fetch(`${FF_API_BASE}/api/commandes-auto/${encodeURIComponent(codefou)}`, { cache: "no-store" });
                        if (res2.ok) {
                            const detail = await res2.json();
                            const f = extractFranco(detail);
                            if (f > 0) return { codefou, franco: f };
                        }
                    } catch { /* ignore */ }
                    // 2. Fallback site=000
                    try {
                        const res3 = await fetch(`${FF_API_BASE}/api/commandes-auto/${encodeURIComponent(codefou)}?site=000`, { cache: "no-store" });
                        if (res3.ok) {
                            const detail = await res3.json();
                            const f = extractFranco(detail);
                            if (f > 0) return { codefou, franco: f };
                        }
                    } catch { /* ignore */ }
                    return { codefou, franco: 0 };
                })
            );

            // Map codefou → franco enrichi
            const francoMap = new Map<string, number>();
            for (const result of details) {
                if (result.status === "fulfilled" && result.value.franco > 0) {
                    francoMap.set(result.value.codefou, result.value.franco);
                }
            }
            console.log(`[pg-ff] pgGetCommandesAuto: francos enrichis:`, Object.fromEntries(francoMap));

            return mapped.map(r => {
                if (r.franco === 0) {
                    const enriched = francoMap.get(r.codefou);
                    if (enriched && enriched > 0) return { ...r, franco: enriched };
                }
                return r;
            });
        }

        return mapped;
    } catch (e) {
        console.error("[pg-ff] pgGetCommandesAuto error:", (e as Error).message?.slice(0, 300));
        return [];
    }
}

// ---------------------------------------------------------------------------
// 12. Dernière réception par fournisseur ET par site (cadencier)
// ---------------------------------------------------------------------------

/**
 * Retourne la date de la dernière réception (entrée de marchandise) par
 * fournisseur et par site, pour piloter le cadencier de commande.
 *
 * Source : mvtart (genremvt IN (1, 2) = réceptions, voir pgGetMensuelByFournisseur).
 * La réception est rattachée à l'article ; on l'attribue au fournisseur
 * principal de l'article (artfou1.preference = 1), comme partout ailleurs.
 *
 * Clé de la Map : `${codefou}|${site}`. Map vide en cas d'erreur
 * (l'UI affichera alors « échéance inconnue »).
 */
export async function pgGetDerniereReceptionParFournisseur(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const result = await pgNoParallel(sql`
            SELECT
                af.code        AS codefou,
                m.site         AS site,
                MAX(m.datmvt)  AS derniere
            FROM mvtart m
            JOIN articles a ON a.no_id = m.artnoid
            JOIN artfou1 af ON af.art_no_id = a.no_id AND af.preference = 1
            WHERE m.genremvt IN (1, 2)
              AND m.site IN ('292', '579')
              AND m.datmvt IS NOT NULL
            GROUP BY af.code, m.site
        `);

        for (const row of result.rows as { codefou: string; site: string; derniere: string | Date }[]) {
            if (!row.codefou || !row.derniere) continue;
            const iso = row.derniere instanceof Date
                ? row.derniere.toISOString()
                : new Date(row.derniere).toISOString();
            map.set(`${String(row.codefou).trim()}|${String(row.site ?? "").trim()}`, iso);
        }
        console.log(`[pg-ff] pgGetDerniereReceptionParFournisseur: ${map.size} entrées (mvtart)`);
        return map;
    } catch (e) {
        console.error("[pg-ff] pgGetDerniereReceptionParFournisseur error:", (e as Error).message?.slice(0, 250));
        return map;
    }
}

// ---------------------------------------------------------------------------
// 13. Recherche & fiche produit (page /produits)
// ---------------------------------------------------------------------------

/**
 * Une ligne de résultat de recherche produit. Volontairement **légère** :
 * aucune agrégation `mvtart` ici (le seq-scan du ILIKE domine déjà le coût).
 * Le détail lourd n'est calculé qu'à l'ouverture de la fiche.
 */
export interface PgProduitSearchRow {
    no_id: number;
    codein: string;
    code_centrale: string;
    libelle1: string;
    /** Nom du fournisseur principal (artfou1.preference = 1), sinon son code. */
    fournisseur: string;
    codefou: string;
    nomenclature_code: string;
    nomenclature: string;
    stock_total: number;
    /** true si le produit a déjà des métriques réseau Qlik en cache. */
    has_reseau: boolean;
    qte_reseau: number;
    nb_magasins_reseau: number;
}

/**
 * Caractères accentués et leur équivalent non accentué, pour `translate()`.
 * Les deux chaînes DOIVENT rester de même longueur, caractère par caractère.
 * Postgres n'a pas `unaccent()` sans l'extension : on ne peut pas compter dessus
 * sur la base FF, d'où cette table de correspondance explicite.
 */
const SQL_ACCENTS_FROM = "àâäãáåéèêëíìîïóòôöõúùûüçñýÿ";
const SQL_ACCENTS_TO = "aaaaaaeeeeiiiiooooouuuucnyy";

/**
 * Normalise un terme de recherche côté JS, de la même façon que
 * `normalizedLibelleSql()` le fait côté SQL : minuscules, accents retirés,
 * toute ponctuation ramenée à un espace.
 */
function normalizeSearchTerm(term: string): string {
    return term
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")  // retire les diacritiques
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** Expression SQL renvoyant le libellé normalisé (minuscules, sans accent ni ponctuation). */
function normalizedLibelleSql() {
    return sql`regexp_replace(translate(lower(COALESCE(a.libelle1, '')), ${SQL_ACCENTS_FROM}, ${SQL_ACCENTS_TO}), '[^a-z0-9]+', ' ', 'g')`;
}

/**
 * Recherche un produit par **libellé** ou par **code centrale** (préfixe).
 * Si le terme est entièrement numérique, on tente aussi une correspondance
 * exacte sur le `codein`.
 *
 * La recherche par libellé est **insensible aux accents et à la ponctuation**,
 * et fonctionne **mot à mot** : « tapis anti-poussière » retrouve
 * « TAPIS ANTI POUSSIERE », et « tapis poussiere » aussi (tous les mots doivent
 * être présents, dans n'importe quel ordre). Sans cette normalisation, un
 * `ILIKE` brut exigeait l'accent ET le tiret exacts et ne remontait rien.
 *
 * ⚠️ Il n'existe aucun index texte sur `articles.libelle1` (base FF resynchronisée
 * chaque nuit depuis SQL Server — on n'y crée pas d'index). La requête fait donc
 * un seq-scan avec normalisation par ligne : l'appelant impose un minimum de
 * 3 caractères et une soumission explicite, jamais une recherche à la frappe.
 */
export async function pgSearchProduits(term: string, limit = 50): Promise<PgProduitSearchRow[]> {
    const cleaned = term.trim();
    if (cleaned.length < 3) return [];

    const prefix = `${cleaned}%`;
    // Mots de la recherche, normalisés. Tous doivent être présents (AND).
    const tokens = normalizeSearchTerm(cleaned).split(" ").filter(Boolean);
    const normLibelle = normalizedLibelleSql();
    const libelleClause = tokens.length > 0
        ? sql`(${sql.join(tokens.map((t) => sql`${normLibelle} LIKE ${`%${t}%`}`), sql` AND `)})`
        : sql`FALSE`;

    // Un terme purement numérique peut être un codein : on l'ajoute au filtre
    // (correspondance exacte, la colonne est space-padded d'où le TRIM).
    const codeinClause = /^\d+$/.test(cleaned)
        ? sql`OR TRIM(a.codein::text) = ${cleaned}`
        : sql``;

    try {
        const result = await pgNoParallel(sql`
            WITH raw AS (
                SELECT DISTINCT ON (TRIM(a.codein::text))
                    a.no_id,
                    TRIM(a.codein::text)                     AS codein,
                    COALESCE(TRIM(a.artcentrale::text), '')  AS code_centrale,
                    COALESCE(a.libelle1, '')                 AS libelle1,
                    a.nom_no_id
                FROM articles a
                WHERE a.codein IS NOT NULL
                  AND (
                        ${libelleClause}
                     OR TRIM(a.artcentrale::text) ILIKE ${prefix}
                     ${codeinClause}
                  )
                ORDER BY TRIM(a.codein::text), a.no_id DESC
            ),
            matched AS (
                SELECT * FROM raw ORDER BY libelle1 LIMIT ${limit}
            )
            SELECT
                m.no_id,
                m.codein,
                m.code_centrale,
                m.libelle1,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur,
                COALESCE(af.code, '')::text                         AS codefou,
                COALESCE(n.code, '')::text                          AS nomenclature_code,
                COALESCE(n.libelle, '')::text                       AS nomenclature,
                COALESCE(st.stock_total, 0)::float                  AS stock_total,
                (q.code_centrale IS NOT NULL)                       AS has_reseau,
                COALESCE(q.qte_reseau, 0)::float                    AS qte_reseau,
                COALESCE(q.nb_magasins_reseau, 0)                   AS nb_magasins_reseau
            FROM matched m
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = m.no_id AND af1.preference = 1
                ORDER BY af1.code
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            LEFT JOIN nomenclature n ON n.no_id = m.nom_no_id
            LEFT JOIN LATERAL (
                SELECT SUM(cs.qte)::float AS stock_total
                FROM cube_stock cs
                WHERE cs.artnoid = m.no_id AND cs.site IN ('292', '579')
            ) st ON TRUE
            LEFT JOIN qlik_network_metrics q ON q.code_centrale = m.code_centrale
            ORDER BY m.libelle1
        `);

        console.log(`[pg-ff] pgSearchProduits("${cleaned}"): ${result.rows.length} résultats`);
        return result.rows as unknown as PgProduitSearchRow[];
    } catch (e) {
        console.error("[pg-ff] pgSearchProduits error:", (e as Error).message?.slice(0, 250));
        return [];
    }
}

/**
 * Rapproche une liste de **codes centraux** (issus de Qlik) du catalogue FF Nancy.
 *
 * C'est l'étape 2 de la recherche produit : Qlik dit quels articles le réseau
 * travaille, cette requête dit lesquels nous référençons — et avec quel
 * `codein`, quel fournisseur et quel stock. Un code absent du résultat est un
 * produit réseau que Nancy ne référence pas (cas normal et intéressant).
 *
 * Les codeins sont renvoyés indexés par code centrale ; un même code centrale
 * peut porter plusieurs codeins (ré-créations d'article), on ne garde que le
 * `no_id` le plus récent.
 */
export async function pgGetProduitsByCodeCentrale(
    codesCentraux: string[],
): Promise<Map<string, PgProduitSearchRow>> {
    const out = new Map<string, PgProduitSearchRow>();
    const codes = [...new Set(codesCentraux.map((c) => c.trim()).filter(Boolean))];
    if (codes.length === 0) return out;

    try {
        const result = await pgNoParallel(sql`
            WITH matched AS (
                SELECT DISTINCT ON (TRIM(a.artcentrale::text))
                    a.no_id,
                    TRIM(a.codein::text)                    AS codein,
                    TRIM(a.artcentrale::text)               AS code_centrale,
                    COALESCE(a.libelle1, '')                AS libelle1,
                    a.nom_no_id
                FROM articles a
                WHERE TRIM(a.artcentrale::text) IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
                  AND a.codein IS NOT NULL
                ORDER BY TRIM(a.artcentrale::text), a.no_id DESC
            )
            SELECT
                m.no_id,
                m.codein,
                m.code_centrale,
                m.libelle1,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur,
                COALESCE(af.code, '')::text                         AS codefou,
                COALESCE(n.code, '')::text                          AS nomenclature_code,
                COALESCE(n.libelle, '')::text                       AS nomenclature,
                COALESCE(st.stock_total, 0)::float                  AS stock_total,
                TRUE                                                AS has_reseau,
                0::float                                            AS qte_reseau,
                0                                                   AS nb_magasins_reseau
            FROM matched m
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = m.no_id AND af1.preference = 1
                ORDER BY af1.code
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            LEFT JOIN nomenclature n ON n.no_id = m.nom_no_id
            LEFT JOIN LATERAL (
                SELECT SUM(cs.qte)::float AS stock_total
                FROM cube_stock cs
                WHERE cs.artnoid = m.no_id AND cs.site IN ('292', '579')
            ) st ON TRUE
        `);

        for (const row of result.rows as unknown as PgProduitSearchRow[]) {
            out.set(row.code_centrale, row);
        }
        console.log(`[pg-ff] pgGetProduitsByCodeCentrale: ${codes.length} codes Qlik → ${out.size} trouvés dans le catalogue Nancy`);
        return out;
    } catch (e) {
        console.error("[pg-ff] pgGetProduitsByCodeCentrale error:", (e as Error).message?.slice(0, 250));
        return out;
    }
}

/**
 * `codein` de l'article portant ce code centrale, ou `null` si Nancy ne le
 * référence pas. Utilisé par la fiche produit ouverte depuis un résultat Qlik
 * (URL `?cc=…`), qui n'a que le code centrale.
 */
export async function pgGetCodeinByCodeCentrale(codeCentrale: string): Promise<string | null> {
    const cleaned = codeCentrale.trim();
    if (!cleaned) return null;
    try {
        const result = await pgNoParallel(sql`
            SELECT TRIM(a.codein::text) AS codein
            FROM articles a
            WHERE TRIM(a.artcentrale::text) = ${cleaned}
              AND a.codein IS NOT NULL
            ORDER BY a.no_id DESC
            LIMIT 1
        `);
        const row = (result.rows as unknown as { codein: string }[])[0];
        return row?.codein ?? null;
    } catch (e) {
        console.error("[pg-ff] pgGetCodeinByCodeCentrale error:", (e as Error).message?.slice(0, 250));
        return null;
    }
}

/** Identité, prix et nomenclature d'un produit (une seule ligne). */
export interface PgProduitDetailRow {
    no_id: number;
    codein: string;
    code_centrale: string;
    libelle1: string;
    nom_no_id: number | null;
    gtin: string;
    reference: string;
    pcb: number | null;
    /** article_infosup.prix_vente_mini */
    pv_central: number | null;
    /** cube_pa.pa */
    pa: number | null;
    code3: string | null;
    libelle3: string | null;
    code2: string | null;
    libelle2: string | null;
    code1: string | null;
    libelle1nom: string | null;
}

/**
 * Fiche d'identité complète d'un produit à partir de son `codein`.
 * Renvoie `null` si le codein est inconnu.
 */
export async function pgGetProduitDetail(codein: string): Promise<PgProduitDetailRow | null> {
    const parentCol = await getNomenclatureParentCol();
    // Hiérarchie nomenclature — deux stratégies :
    //
    //  1. Colonne parent entière si elle existe (FK vers le no_id du niveau au-dessus).
    //  2. Sinon, remontée par **préfixe de code** : la nomenclature FF est encodée
    //     hiérarchiquement, secteur = 2 chiffres, famille = 4, sous-famille = 6
    //     (ex "330702" → "3307" → "33"). En production `nomenclature` n'expose que
    //     no_id / code / libelle / niveau / chemin_pere : aucune FK entière, et
    //     `chemin_pere` est un chemin texte. Sans ce repli, Secteur et Famille
    //     restaient vides sur la fiche.
    const hierarchy = parentCol
        ? sql`
            LEFT JOIN nomenclature n2 ON n2.no_id = n3.${sql.raw(parentCol)}
            LEFT JOIN nomenclature n1 ON n1.no_id = n2.${sql.raw(parentCol)}
        `
        : sql`
            LEFT JOIN LATERAL (
                SELECT nx.code, nx.libelle
                FROM nomenclature nx
                WHERE LENGTH(TRIM(n3.code)) >= 4
                  AND TRIM(nx.code) = LEFT(TRIM(n3.code), 4)
                LIMIT 1
            ) n2 ON TRUE
            LEFT JOIN LATERAL (
                SELECT nx.code, nx.libelle
                FROM nomenclature nx
                WHERE LENGTH(TRIM(n3.code)) >= 2
                  AND TRIM(nx.code) = LEFT(TRIM(n3.code), 2)
                LIMIT 1
            ) n1 ON TRUE
        `;
    // Les colonnes sont identiques dans les deux stratégies (alias n1 / n2).
    const hierarchyCols = sql`,
            n2.code    AS code2,
            n2.libelle AS libelle2,
            n1.code    AS code1,
            n1.libelle AS libelle1nom`;

    try {
        const result = await pgNoParallel(sql`
            SELECT
                a.no_id,
                TRIM(a.codein::text)                    AS codein,
                COALESCE(TRIM(a.artcentrale::text), '') AS code_centrale,
                COALESCE(a.libelle1, '')                AS libelle1,
                a.nom_no_id,
                COALESCE(ag.gtin, af.ean13, '')::text   AS gtin,
                COALESCE(af.reference, '')::text        AS reference,
                af.pcb::float                           AS pcb,
                ai.prix_vente_mini::float               AS pv_central,
                pa.pa::float                            AS pa,
                n3.code                                 AS code3,
                n3.libelle                              AS libelle3
                ${hierarchyCols}
            FROM articles a
            LEFT JOIN LATERAL (
                SELECT af1.code, af1.pcb, af1.reference, af1.ean13
                FROM artfou1 af1
                WHERE af1.art_no_id = a.no_id
                ORDER BY af1.preference DESC NULLS LAST, af1.no_id DESC
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN art_gtin ag         ON ag.idarticle = a.no_id AND ag.preferentiel = 1
            LEFT JOIN article_infosup ai  ON ai.artnoid = a.no_id
            LEFT JOIN cube_pa pa          ON pa.artnoid = a.no_id
            LEFT JOIN nomenclature n3     ON n3.no_id = a.nom_no_id
            ${hierarchy}
            WHERE TRIM(a.codein::text) = ${codein}
            ORDER BY a.no_id DESC
            LIMIT 1
        `);

        const row = (result.rows as unknown as PgProduitDetailRow[])[0] ?? null;
        console.log(`[pg-ff] pgGetProduitDetail(${codein}): ${row ? "trouvé" : "introuvable"}`);
        return row;
    } catch (e) {
        console.error("[pg-ff] pgGetProduitDetail error:", (e as Error).message?.slice(0, 250));
        return null;
    }
}

/** Un fournisseur référencé pour l'article. */
export interface PgProduitFournisseurRow {
    codefou: string;
    nomfou: string;
    reference: string;
    pcb: number | null;
    /** true si artfou1.preference = 1 */
    principal: boolean;
}

/** Tous les fournisseurs référencés pour un article (le principal en premier). */
export async function pgGetFournisseursByCodein(codein: string): Promise<PgProduitFournisseurRow[]> {
    try {
        const result = await pgNoParallel(sql`
            SELECT DISTINCT ON (af.code)
                af.code::text                        AS codefou,
                COALESCE(fi.nom, af.code)::text      AS nomfou,
                COALESCE(af.reference, '')::text     AS reference,
                af.pcb::float                        AS pcb,
                (af.preference = 1)                  AS principal
            FROM articles a
            JOIN artfou1 af ON af.art_no_id = a.no_id
            LEFT JOIN fouident fi ON fi.code = af.code
            WHERE TRIM(a.codein::text) = ${codein}
            ORDER BY af.code, af.preference DESC NULLS LAST, af.no_id DESC
        `);
        const rows = result.rows as unknown as PgProduitFournisseurRow[];
        // Le principal remonte en tête (le DISTINCT ON impose un tri par code).
        rows.sort((x, y) => Number(y.principal) - Number(x.principal) || x.nomfou.localeCompare(y.nomfou, "fr"));
        return rows;
    } catch (e) {
        console.error("[pg-ff] pgGetFournisseursByCodein error:", (e as Error).message?.slice(0, 250));
        return [];
    }
}

/** Stock temps réel par site pour un article. */
export interface PgProduitStockRow {
    site: string;
    stockdispo: number;
    qte: number;
    valstock: number;
    prmp: number;
    dernierevente: string | null;
    dernierereception: string | null;
}

export async function pgGetStockByCodein(codein: string): Promise<PgProduitStockRow[]> {
    try {
        const result = await pgNoParallel(sql`
            SELECT
                cs.site,
                COALESCE(cs.stockdispo, 0)::float AS stockdispo,
                COALESCE(cs.qte, 0)::float        AS qte,
                COALESCE(cs.valstock, 0)::float   AS valstock,
                COALESCE(cs.prmp, 0)::float       AS prmp,
                cs.dernierevente::text            AS dernierevente,
                cs.dernierereception::text        AS dernierereception
            FROM cube_stock cs
            JOIN articles a ON a.no_id = cs.artnoid
            WHERE TRIM(a.codein::text) = ${codein}
              AND cs.site IN ('292', '579')
            ORDER BY cs.site
        `);
        return result.rows as unknown as PgProduitStockRow[];
    } catch (e) {
        console.error("[pg-ff] pgGetStockByCodein error:", (e as Error).message?.slice(0, 250));
        return [];
    }
}

/** Quantité totale en commande fournisseur pour un article. */
export async function pgGetCommandesByCodein(codein: string): Promise<number> {
    try {
        const result = await pgNoParallel(sql`
            SELECT COALESCE(SUM(cv.cdefou_ligne_qtecde), 0)::float AS qtecde
            FROM cdefou_vivant cv
            WHERE TRIM(cv.articles_codein::text) = ${codein}
        `);
        const row = (result.rows as unknown as { qtecde: number }[])[0];
        return Number(row?.qtecde) || 0;
    } catch (e) {
        console.error("[pg-ff] pgGetCommandesByCodein error:", (e as Error).message?.slice(0, 250));
        return 0;
    }
}

/** Une gamme affectée à l'article pour une saison donnée. */
export interface PgGammeHistoryRow {
    saison_no_id: number;
    saison_code: string | null;
    saison_libelle: string | null;
    gamme_code: string;
    gamme_libelle: string | null;
}

/**
 * Historique complet des gammes de l'article, saison par saison (la plus
 * récente en premier). Le reste de l'application ne lit que la saison active
 * (`pgGetGammesByFournisseur`) ; ici on veut la trajectoire d'arbitrage.
 */
export async function pgGetGammeHistoryByCodein(codein: string): Promise<PgGammeHistoryRow[]> {
    try {
        const result = await pgNoParallel(sql`
            SELECT
                s.no_id            AS saison_no_id,
                s.code::text       AS saison_code,
                s.libelle::text    AS saison_libelle,
                g.code::text       AS gamme_code,
                g.libelle::text    AS gamme_libelle
            FROM art_gamme_saison ags
            JOIN articles a ON a.no_id = ags.artnoid
            JOIN gammes g   ON g.no_id = ags.idgamme
            JOIN saisons s  ON s.no_id = ags.idsaison
            WHERE TRIM(a.codein::text) = ${codein}
            ORDER BY s.no_id DESC
        `);
        return result.rows as unknown as PgGammeHistoryRow[];
    } catch (e) {
        console.error("[pg-ff] pgGetGammeHistoryByCodein error:", (e as Error).message?.slice(0, 250));
        return [];
    }
}

/**
 * Données mensuelles (ventes / CA / marge / stock fin de mois / réceptions)
 * d'UN article, par site et par mois.
 *
 * Reprend **exactement** le calcul canonique de `pgGetMensuelByFournisseur`
 * (la source de vérité de la Grille) : seule la sélection change — filtre sur
 * le codein au lieu d'une jointure `artfou1`. Les chiffres affichés sur la
 * fiche produit sont donc identiques à ceux de la Grille, par construction.
 */
export async function pgGetMensuelByCodein(
    codein: string,
    dateDebut: string,
    dateFin: string
): Promise<PgMensuelRow[]> {
    try {
        const result = await pgNoParallel(sql`
            WITH base AS (
                SELECT
                    TRIM(a.codein::text)          AS codein,
                    m.site,
                    TO_CHAR(m.datmvt, 'YYYY-MM')  AS mois,
                    m.qtemvt,
                    m.mntmvtttc,
                    m.margemvt,
                    m.genremvt,
                    m.qtestock,
                    ROW_NUMBER() OVER (
                        PARTITION BY m.site, TO_CHAR(m.datmvt, 'YYYY-MM')
                        ORDER BY m.datmvt DESC
                    ) AS rn_last
                FROM mvtart m
                JOIN articles a ON a.no_id = m.artnoid
                WHERE TRIM(a.codein::text) = ${codein}
                  AND m.datmvt BETWEEN ${dateDebut}::date AND ${dateFin}::date
                  AND m.site IN ('292', '579')
            )
            SELECT
                codein,
                site,
                mois,
                SUM(CASE WHEN genremvt = 3 THEN -qtemvt    ELSE 0 END)::float     AS qte_vendue,
                SUM(CASE WHEN genremvt = 3 THEN -mntmvtttc ELSE 0 END)::float     AS ca_ht,
                SUM(CASE WHEN genremvt = 3 THEN  margemvt  ELSE 0 END)::float     AS marge,
                MAX(CASE WHEN rn_last = 1 THEN qtestock ELSE NULL END)::float     AS stock_fin_mois,
                SUM(CASE WHEN genremvt IN (1, 2) THEN qtemvt ELSE 0 END)::float   AS qte_recue
            FROM base
            GROUP BY codein, site, mois
            ORDER BY site, mois
        `);

        console.log(`[pg-ff] pgGetMensuelByCodein(${codein}): ${result.rows.length} lignes`);
        return result.rows as unknown as PgMensuelRow[];
    } catch (e) {
        console.error("[pg-ff] pgGetMensuelByCodein error:", (e as Error).message?.slice(0, 250));
        return [];
    }
}

/** Un produit de la même famille, comparé local vs réseau. */
export interface PgOpportuniteRow {
    codein: string;
    libelle1: string;
    code_centrale: string;
    fournisseur: string;
    qte_reseau: number;
    nb_magasins_reseau: number;
    ca_reseau: number;
    ca_par_magasin_reseau: number;
    qte_locale: number;
    nb_sites_locaux: number;
    qte_reseau_par_magasin: number;
    qte_locale_par_magasin: number;
    /** Écart réseau − local, par magasin, sur 12 mois. Positif = opportunité. */
    ecart_par_magasin: number;
}

/**
 * Produits de la même nomenclature, classés par écart entre la performance
 * réseau et la performance locale (quantités **par magasin**, pour neutraliser
 * la différence d'échelle entre ~270 magasins et nos 2 sites).
 *
 * Périmètre volontairement borné aux articles **de notre catalogue** ayant déjà
 * des métriques réseau en cache : la dimension Qlik interrogée est
 * `Article Code`, on ne peut pas découvrir un produit que Nancy ne référence pas.
 */
export async function pgGetOpportunitesFamille(
    nomNoId: number,
    dateDebut: string,
    dateFin: string,
    limit = 30
): Promise<PgOpportuniteRow[]> {
    try {
        const result = await pgNoParallel(sql`
            WITH famille AS (
                SELECT DISTINCT ON (TRIM(a.codein::text))
                    a.no_id,
                    TRIM(a.codein::text)      AS codein,
                    TRIM(a.artcentrale::text) AS code_centrale,
                    COALESCE(a.libelle1, '')  AS libelle1
                FROM articles a
                WHERE a.nom_no_id = ${nomNoId}
                  AND a.codein IS NOT NULL
                  AND a.artcentrale IS NOT NULL
                  AND TRIM(a.artcentrale::text) <> ''
                ORDER BY TRIM(a.codein::text), a.no_id DESC
            ),
            avec_reseau AS (
                SELECT
                    f.no_id,
                    f.codein,
                    f.code_centrale,
                    f.libelle1,
                    q.qte_reseau::float             AS qte_reseau,
                    q.nb_magasins_reseau            AS nb_magasins_reseau,
                    COALESCE(q.ca_reseau, 0)::float AS ca_reseau,
                    COALESCE(q.ca_par_magasin_reseau, 0)::float AS ca_par_magasin_reseau
                FROM famille f
                JOIN qlik_network_metrics q ON q.code_centrale = f.code_centrale
                WHERE q.nb_magasins_reseau > 0
                  AND q.qte_reseau > 0
            ),
            ventes AS (
                SELECT
                    TRIM(a.codein::text)      AS codein,
                    SUM(-m.qtemvt)::float     AS qte_locale,
                    COUNT(DISTINCT m.site)    AS nb_sites_locaux
                FROM mvtart m
                JOIN articles a ON a.no_id = m.artnoid
                WHERE m.genremvt = 3
                  AND m.site IN ('292', '579')
                  AND m.datmvt BETWEEN ${dateDebut}::date AND ${dateFin}::date
                  AND TRIM(a.codein::text) IN (SELECT codein FROM avec_reseau)
                GROUP BY TRIM(a.codein::text)
            )
            SELECT
                r.codein,
                r.libelle1,
                r.code_centrale,
                COALESCE(fi.nom, af.code, 'Sans fournisseur')::text AS fournisseur,
                r.qte_reseau,
                r.nb_magasins_reseau,
                r.ca_reseau,
                r.ca_par_magasin_reseau,
                COALESCE(v.qte_locale, 0)::float   AS qte_locale,
                COALESCE(v.nb_sites_locaux, 0)     AS nb_sites_locaux,
                (r.qte_reseau / r.nb_magasins_reseau)::float AS qte_reseau_par_magasin,
                (COALESCE(v.qte_locale, 0) / GREATEST(COALESCE(v.nb_sites_locaux, 0), 1))::float AS qte_locale_par_magasin,
                (
                    (r.qte_reseau / r.nb_magasins_reseau)
                    - (COALESCE(v.qte_locale, 0) / GREATEST(COALESCE(v.nb_sites_locaux, 0), 1))
                )::float AS ecart_par_magasin
            FROM avec_reseau r
            LEFT JOIN ventes v ON v.codein = r.codein
            LEFT JOIN LATERAL (
                SELECT af1.code
                FROM artfou1 af1
                WHERE af1.art_no_id = r.no_id AND af1.preference = 1
                ORDER BY af1.code
                LIMIT 1
            ) af ON TRUE
            LEFT JOIN fouident fi ON fi.code = af.code
            ORDER BY ecart_par_magasin DESC
            LIMIT ${limit}
        `);

        console.log(`[pg-ff] pgGetOpportunitesFamille(nom=${nomNoId}): ${result.rows.length} lignes`);
        return result.rows as unknown as PgOpportuniteRow[];
    } catch (e) {
        console.error("[pg-ff] pgGetOpportunitesFamille error:", (e as Error).message?.slice(0, 250));
        return [];
    }
}
