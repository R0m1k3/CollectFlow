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
import { and, asc, desc, eq, ilike, or, sql, lt, type SQL } from "drizzle-orm";
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
            payload: r,
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

/** Construit la clause WHERE commune à la grille et à la recherche transversale. */
function buildWhere(q: GridQuery): SQL | undefined {
    const clauses: SQL[] = [];
    if (q.codeFournisseur) clauses.push(eq(gridRows.codeFournisseur, q.codeFournisseur));
    if (q.gamme) clauses.push(eq(gridRows.codeGamme, q.gamme));
    if (q.code1) clauses.push(eq(gridRows.code1, q.code1));
    if (q.code2) clauses.push(eq(gridRows.code2, q.code2));
    if (q.code3) clauses.push(eq(gridRows.code3, q.code3));
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

    const [countRow] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(gridRows)
        .where(where);

    const selection = db
        .select({ payload: gridRows.payload, computedAt: gridRows.computedAt })
        .from(gridRows)
        .where(where)
        .orderBy(orderBy, asc(gridRows.codein));

    const found = limit != null
        ? await selection.limit(limit).offset((page - 1) * limit)
        : await selection;

    let oldest: Date | null = null;
    for (const r of found) {
        if (r.computedAt && (!oldest || r.computedAt < oldest)) oldest = r.computedAt;
    }

    return {
        rows: found.map((r) => r.payload as ProductRow),
        total: countRow?.total ?? 0,
        computedAt: oldest ? oldest.toISOString() : null,
    };
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
        row: found.payload as ProductRow,
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
