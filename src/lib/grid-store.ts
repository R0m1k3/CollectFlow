/**
 * CollectFlow — Instantané persisté de la grille (table `grid_rows`).
 *
 * `getProductRows()` reconstruit la grille en direct (6 requêtes SQL sur la base
 * miroir FF + jointure Qlik) et ne la garde qu'en mémoire 10 minutes. L'API `/api/v1`
 * ne doit **jamais** déclencher ce calcul : elle lit cette table, remplie en effet de
 * bord quand quelqu'un ouvre la Grille.
 *
 * On n'introduit donc aucun calcul supplémentaire — on arrête de jeter un résultat
 * qui existe déjà, et il survit désormais aux redémarrages.
 */

import "server-only";

import { db } from "@/db";
import { gridRows } from "@/db/schema";
import { and, asc, desc, eq, ilike, inArray, or, sql, lt, type SQL } from "drizzle-orm";
import type { ProductRow } from "@/types/grid";

/** Colonnes autorisées au tri — liste blanche, jamais l'entrée utilisateur brute. */
const SORTABLE = {
    libelle1: gridRows.libelle1,
    codein: gridRows.codein,
    codeFournisseur: gridRows.codeFournisseur,
    codeGamme: gridRows.codeGamme,
    totalCa: gridRows.totalCa,
    totalQuantite: gridRows.totalQuantite,
    totalMarge: gridRows.totalMarge,
    tauxMarge: gridRows.tauxMarge,
    stockActuel: gridRows.stockActuel,
    caReseau: gridRows.caReseau,
    qteReseau: gridRows.qteReseau,
    nbMagasinsReseau: gridRows.nbMagasinsReseau,
    caParMagasinReseau: gridRows.caParMagasinReseau,
    computedAt: gridRows.computedAt,
} as const;

export type GridSortKey = keyof typeof SORTABLE;
export const GRID_SORT_KEYS = Object.keys(SORTABLE) as GridSortKey[];

export interface GridQuery {
    codeFournisseur?: string;
    gamme?: string;
    code1?: string;
    code2?: string;
    code3?: string;
    /** Préfixe de nomenclature (« 32 », « 3202 », « 320211 ») — filtre sur code3. */
    nomenclature?: string;
    /** Recherche libre : libellé, codein, GTIN, référence, code centrale. */
    search?: string;
    sort?: GridSortKey;
    order?: "asc" | "desc";
    page?: number;
    limit?: number;
}

export interface GridQueryResult {
    rows: ProductRow[];
    total: number;
    /** Calcul le plus ancien parmi les lignes renvoyées — fraîcheur de la donnée. */
    computedAt: string | null;
}

/**
 * Version du format des lignes persistées. À incrémenter dès qu'un champ de
 * `ProductRow` est ajouté ou change de sens : les instantanés plus anciens ne
 * seront plus servis à la Grille (recalcul), mais restent lisibles par /api/v1.
 */
export const GRID_PAYLOAD_VERSION = 1;

/**
 * Persiste les lignes calculées pour un fournisseur.
 *
 * Stratégie : toutes les lignes du lot portent le même `computedAt`, puis on supprime
 * celles du fournisseur restées sur un `computedAt` antérieur. Cela purge les articles
 * disparus du catalogue sans avoir à passer des centaines de codein en paramètres.
 */
export async function upsertGridRows(codeFournisseur: string, rows: ProductRow[]): Promise<number> {
    if (!codeFournisseur || rows.length === 0) return 0;
    const computedAt = new Date();

    const values = rows
        .filter((r) => r.codein)
        .map((r) => ({
            codeFournisseur,
            codein: r.codein,
            nomFournisseur: r.nomFournisseur ?? null,
            libelle1: r.libelle1 ?? null,
            gtin: r.gtin ?? null,
            reference: r.reference ?? null,
            codeCentrale: r.codeCentrale ?? null,
            code1: r.code1 ?? null,
            code2: r.code2 ?? null,
            code3: r.code3 ?? null,
            codeGamme: r.codeGamme ?? null,
            codeGammeInit: r.codeGammeInit ?? null,
            totalCa: r.totalCa != null ? String(r.totalCa) : null,
            totalQuantite: r.totalQuantite != null ? String(r.totalQuantite) : null,
            totalMarge: r.totalMarge != null ? String(r.totalMarge) : null,
            tauxMarge: r.tauxMarge != null ? String(r.tauxMarge) : null,
            stockActuel: r.stockActuel != null ? String(r.stockActuel) : null,
            caReseau: r.caReseau != null ? String(r.caReseau) : null,
            qteReseau: r.qteReseau != null ? String(r.qteReseau) : null,
            nbMagasinsReseau: r.nbMagasinsReseau ?? null,
            caParMagasinReseau: r.caParMagasinReseau != null ? String(r.caParMagasinReseau) : null,
            margePctReseau: r.margePctReseau != null ? String(r.margePctReseau) : null,
            payload: { ...r, payloadVersion: GRID_PAYLOAD_VERSION },
            computedAt,
        }));
    if (values.length === 0) return 0;

    const CHUNK = 200; // payload jsonb volumineux : lots plus petits que pour des scalaires
    let written = 0;
    for (let i = 0; i < values.length; i += CHUNK) {
        const batch = values.slice(i, i + CHUNK);
        await db
            .insert(gridRows)
            .values(batch)
            .onConflictDoUpdate({
                target: [gridRows.codeFournisseur, gridRows.codein],
                set: {
                    nomFournisseur: sql`excluded.nom_fournisseur`,
                    libelle1: sql`excluded.libelle1`,
                    gtin: sql`excluded.gtin`,
                    reference: sql`excluded.reference`,
                    codeCentrale: sql`excluded.code_centrale`,
                    code1: sql`excluded.code1`,
                    code2: sql`excluded.code2`,
                    code3: sql`excluded.code3`,
                    codeGamme: sql`excluded.code_gamme`,
                    codeGammeInit: sql`excluded.code_gamme_init`,
                    totalCa: sql`excluded.total_ca`,
                    totalQuantite: sql`excluded.total_quantite`,
                    totalMarge: sql`excluded.total_marge`,
                    tauxMarge: sql`excluded.taux_marge`,
                    stockActuel: sql`excluded.stock_actuel`,
                    caReseau: sql`excluded.ca_reseau`,
                    qteReseau: sql`excluded.qte_reseau`,
                    nbMagasinsReseau: sql`excluded.nb_magasins_reseau`,
                    caParMagasinReseau: sql`excluded.ca_par_magasin_reseau`,
                    margePctReseau: sql`excluded.marge_pct_reseau`,
                    payload: sql`excluded.payload`,
                    computedAt: sql`excluded.computed_at`,
                },
            });
        written += batch.length;
    }

    // Purge des articles qui ne font plus partie du catalogue du fournisseur.
    await db.delete(gridRows).where(
        and(eq(gridRows.codeFournisseur, codeFournisseur), lt(gridRows.computedAt, computedAt)),
    );

    return written;
}

/**
 * Instantané complet d'un fournisseur, tel que persisté par le dernier calcul.
 *
 * Renvoie `null` (→ recalcul) si rien n'est persisté, si une ligne est d'une
 * version de format antérieure, ou si le calcul date d'un autre mois que le mois
 * en cours : la fenêtre des 12 mois glissants aurait changé entre-temps.
 * Les lignes sont rendues dans l'ordre du calcul en direct (identifiant article).
 */
export async function readGridSnapshot(
    codeFournisseur: string,
): Promise<{ rows: ProductRow[]; computedAt: Date } | null> {
    const found = await db
        .select({ payload: gridRows.payload, computedAt: gridRows.computedAt })
        .from(gridRows)
        .where(eq(gridRows.codeFournisseur, codeFournisseur));
    if (found.length === 0) return null;

    let oldest: Date | null = null;
    const rows: ProductRow[] = [];
    for (const r of found) {
        const row = r.payload as ProductRow;
        if (row.payloadVersion !== GRID_PAYLOAD_VERSION) return null;
        if (!oldest || r.computedAt < oldest) oldest = r.computedAt;
        rows.push(row);
    }
    const now = new Date();
    if (!oldest || oldest.getFullYear() !== now.getFullYear() || oldest.getMonth() !== now.getMonth()) {
        return null;
    }
    rows.sort((a, b) => (a.noid ?? 0) - (b.noid ?? 0));
    return { rows, computedAt: oldest };
}

/**
 * Reporte des gammes enregistrées dans l'instantané persisté (colonne et payload),
 * pour que /api/v1 les voie sans attendre un recalcul complet de la grille.
 */
export async function updateGridRowsGamme(
    codeFournisseur: string,
    changes: ReadonlyArray<{ codein: string; codeGamme: string }>,
): Promise<void> {
    const parGamme = new Map<string, string[]>();
    for (const c of changes) {
        const codeins = parGamme.get(c.codeGamme) ?? [];
        codeins.push(c.codein);
        parGamme.set(c.codeGamme, codeins);
    }
    const CHUNK = 5000; // bien en deçà des 65 535 paramètres liés de PostgreSQL
    for (const [gamme, codeins] of parGamme) {
        for (let i = 0; i < codeins.length; i += CHUNK) {
            await db
                .update(gridRows)
                .set({
                    codeGamme: gamme,
                    payload: sql`jsonb_set(${gridRows.payload}, '{codeGamme}', to_jsonb(${gamme}::text))`,
                })
                .where(and(
                    eq(gridRows.codeFournisseur, codeFournisseur),
                    inArray(gridRows.codein, codeins.slice(i, i + CHUNK)),
                ));
        }
    }
}

/** Construit la clause WHERE commune à la grille et à la recherche transversale. */
function buildWhere(q: GridQuery): SQL | undefined {
    const clauses: SQL[] = [];
    if (q.codeFournisseur) clauses.push(eq(gridRows.codeFournisseur, q.codeFournisseur));
    if (q.gamme) clauses.push(eq(gridRows.codeGamme, q.gamme));
    if (q.code1) clauses.push(eq(gridRows.code1, q.code1));
    if (q.code2) clauses.push(eq(gridRows.code2, q.code2));
    if (q.code3) clauses.push(eq(gridRows.code3, q.code3));
    // Filtre par **préfixe** de nomenclature : « 32 », « 3202 » ou « 320211 ».
    // C'est celui à utiliser avec /api/v1/nomenclatures, car il ne dépend pas de
    // code1/code2 — parfois vides quand la hiérarchie n'a pas pu être remontée.
    if (q.nomenclature) clauses.push(sql`${gridRows.code3} like ${q.nomenclature + "%"}`);
    const search = q.search?.trim();
    if (search) {
        const pattern = `%${search}%`;
        const alt = or(
            ilike(gridRows.libelle1, pattern),
            ilike(gridRows.codein, pattern),
            ilike(gridRows.gtin, pattern),
            ilike(gridRows.reference, pattern),
            ilike(gridRows.codeCentrale, pattern),
        );
        if (alt) clauses.push(alt);
    }
    return clauses.length ? and(...clauses) : undefined;
}

/**
 * Lit les lignes de grille persistées : filtre, tri et pagination faits en SQL.
 * Ne déclenche aucun recalcul et ne contacte jamais Qlik.
 */
export async function queryGridRows(q: GridQuery): Promise<GridQueryResult> {
    const page = Math.max(1, q.page ?? 1);
    // `limit` absent = aucune limite : on renvoie toutes les lignes du filtre.
    // Il y avait ici un Math.min(500, …) qui re-plafonnait en silence, quelle que
    // soit la valeur demandée — la réponse était tronquée sans que rien ne le dise.
    const limit = q.limit != null ? Math.max(1, q.limit) : null;
    const where = buildWhere(q);

    const sortCol = SORTABLE[q.sort ?? "totalCa"] ?? gridRows.totalCa;
    // NULLS LAST dans les deux sens : un produit sans CA ne doit jamais occuper la tête.
    const orderBy = q.order === "asc" ? asc(sortCol) : desc(sortCol);

    const selection = db
        .select({ payload: gridRows.payload, computedAt: gridRows.computedAt })
        .from(gridRows)
        .where(where)
        .orderBy(orderBy, asc(gridRows.codein));

    // Comptage et page en parallèle : deux connexions du pool, un seul temps d'attente.
    const [[countRow], found] = await Promise.all([
        db.select({ total: sql<number>`count(*)::int` }).from(gridRows).where(where),
        limit != null ? selection.limit(limit).offset((page - 1) * limit) : selection,
    ]);

    let oldest: Date | null = null;
    for (const r of found) {
        if (r.computedAt && (!oldest || r.computedAt < oldest)) oldest = r.computedAt;
    }

    return {
        rows: found.map((r) => versLigneApi(r.payload)),
        total: countRow?.total ?? 0,
        computedAt: oldest ? oldest.toISOString() : null,
    };
}

/** Ligne exposée par l'API : la version de format est un détail interne. */
function versLigneApi(payload: unknown): ProductRow {
    const ligne = { ...(payload as ProductRow) };
    delete ligne.payloadVersion;
    return ligne;
}

/** Fiche complète d'un produit. `codeFournisseur` lève l'ambiguïté d'un article multi-fournisseurs. */
export async function getGridRowByCodein(
    codein: string,
    codeFournisseur?: string,
): Promise<{ row: ProductRow; computedAt: string | null } | null> {
    const clauses: SQL[] = [eq(gridRows.codein, codein)];
    if (codeFournisseur) clauses.push(eq(gridRows.codeFournisseur, codeFournisseur));

    const [found] = await db
        .select({ payload: gridRows.payload, computedAt: gridRows.computedAt })
        .from(gridRows)
        .where(and(...clauses))
        .orderBy(desc(gridRows.computedAt))
        .limit(1);

    if (!found) return null;
    return {
        row: versLigneApi(found.payload),
        computedAt: found.computedAt ? found.computedAt.toISOString() : null,
    };
}

/**
 * Indique si un fournisseur a déjà été calculé au moins une fois.
 * Sert à répondre `202 not_ready` plutôt que de déclencher un calcul long.
 */
export async function getGridFreshness(
    codeFournisseur: string,
): Promise<{ rowCount: number; computedAt: string | null } | null> {
    const [found] = await db
        .select({
            rowCount: sql<number>`count(*)::int`,
            computedAt: sql<Date | null>`max(${gridRows.computedAt})`,
        })
        .from(gridRows)
        .where(eq(gridRows.codeFournisseur, codeFournisseur));

    if (!found || found.rowCount === 0) return null;
    return {
        rowCount: found.rowCount,
        computedAt: found.computedAt ? new Date(found.computedAt).toISOString() : null,
    };
}

/** Fournisseurs présents dans l'instantané, avec leur fraîcheur. */
export async function listGridSuppliers(): Promise<
    Array<{ codeFournisseur: string; nomFournisseur: string | null; rowCount: number; computedAt: string | null }>
> {
    const found = await db
        .select({
            codeFournisseur: gridRows.codeFournisseur,
            nomFournisseur: sql<string | null>`max(${gridRows.nomFournisseur})`,
            rowCount: sql<number>`count(*)::int`,
            computedAt: sql<Date | null>`max(${gridRows.computedAt})`,
        })
        .from(gridRows)
        .groupBy(gridRows.codeFournisseur)
        .orderBy(asc(gridRows.codeFournisseur));

    return found.map((r) => ({
        codeFournisseur: r.codeFournisseur,
        nomFournisseur: r.nomFournisseur,
        rowCount: r.rowCount,
        computedAt: r.computedAt ? new Date(r.computedAt).toISOString() : null,
    }));
}

// ---------------------------------------------------------------------------
// Inventaire des nomenclatures d'un fournisseur
// ---------------------------------------------------------------------------

/** Un poste de nomenclature, avec son poids — de quoi décider par où découper. */
export interface GridNomenclature {
    code: string;
    /** Libellé du poste, lu dans le payload (il n'a pas de colonne dédiée). */
    libelle: string | null;
    nbArticles: number;
    totalCa: number;
    totalQuantite: number;
}

/** Longueur du code pour chaque niveau : « 32 » → « 3202 » → « 320211 ». */
export const NOMENCLATURE_LONGUEURS: Record<1 | 2 | 3, number> = { 1: 2, 2: 4, 3: 6 };

/**
 * Répartition des articles d'un fournisseur par niveau de nomenclature.
 *
 * Sans cela, un appelant qui veut découper un gros fournisseur par nomenclature
 * est coincé : le filtre existe sur `/grid`, mais rien ne lui dit **quelles**
 * valeurs existent — il devrait tout télécharger pour les découvrir, ce qui
 * annule le bénéfice du découpage.
 *
 * Les niveaux sont dérivés par **préfixe de `code3`** (codes hiérarchiques à 6
 * chiffres, de 31xxxx à 40xxxx), et non des colonnes `code1`/`code2`. Celles-ci
 * ne sont renseignées que si `pgGetNomenclatureByFournisseur` a su remonter la
 * hiérarchie, ce qui dépend d'une détection heuristique de la colonne parent de
 * la table `nomenclature` ; quand elle échoue, seul `code3` est rempli. Le
 * préfixe, lui, est toujours disponible.
 *
 * Tout est agrégé en SQL : la réponse fait quelques dizaines de lignes, même pour
 * un fournisseur de 130 000 articles.
 */
export async function listGridNomenclatures(
    codeFournisseur: string,
    niveau: 1 | 2 | 3,
    parent?: string,
): Promise<GridNomenclature[]> {
    const longueur = NOMENCLATURE_LONGUEURS[niveau];
    const codeExpr = sql<string>`left(${gridRows.code3}, ${longueur})`;
    // Les libellés n'ont pas de colonne dédiée : on les lit dans le payload.
    // Aux niveaux 1 et 2 ils peuvent être absents (même cause que ci-dessus) ;
    // le code et les compteurs, eux, restent justes.
    const libelleKey = niveau === 1 ? "libelleNiveau1" : niveau === 2 ? "libelleNiveau2" : "libelle3";

    const clauses: SQL[] = [
        eq(gridRows.codeFournisseur, codeFournisseur),
        sql`${gridRows.code3} is not null and length(${gridRows.code3}) >= ${longueur}`,
    ];
    // `parent` est lui aussi un préfixe : « 32 » pour descendre au niveau 2.
    if (parent) clauses.push(sql`${gridRows.code3} like ${parent + "%"}`);

    const rows = await db
        .select({
            code: codeExpr,
            libelle: sql<string | null>`max(${gridRows.payload} ->> ${libelleKey})`,
            nbArticles: sql<number>`count(*)::int`,
            totalCa: sql<number>`coalesce(sum(${gridRows.totalCa}), 0)::float`,
            totalQuantite: sql<number>`coalesce(sum(${gridRows.totalQuantite}), 0)::float`,
        })
        .from(gridRows)
        .where(and(...clauses))
        .groupBy(codeExpr)
        .orderBy(desc(sql`coalesce(sum(${gridRows.totalCa}), 0)`));

    return rows.map((r) => ({
        code: String(r.code ?? ""),
        libelle: r.libelle ?? null,
        nbArticles: Number(r.nbArticles) || 0,
        totalCa: Number(r.totalCa) || 0,
        totalQuantite: Number(r.totalQuantite) || 0,
    }));
}
