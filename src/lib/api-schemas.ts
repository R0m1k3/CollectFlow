/**
 * CollectFlow — Validation des paramètres de l'API `/api/v1` (zod).
 *
 * Toute entrée utilisateur passe par ici : bornes de pagination, listes blanches
 * de tri, projection de champs. Les erreurs remontent en `400 bad_request` avec
 * le détail zod, pour que l'appelant sache quoi corriger.
 */

import { z } from "zod";
import { GRID_SORT_KEYS, type GridSortKey } from "@/lib/grid-store";

const SORT_KEYS = GRID_SORT_KEYS as readonly string[];

export const paginationShape = {
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(100),
};

const sortShape = {
    sort: z
        .string()
        .refine((v) => SORT_KEYS.includes(v), {
            message: `Tri inconnu. Valeurs acceptées : ${SORT_KEYS.join(", ")}`,
        })
        .optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
    /** Liste de champs de ProductRow à conserver, séparés par des virgules. */
    fields: z.string().optional(),
    /**
     * `1` (défaut) : relit les métriques réseau Qlik et la gamme serveur au moment
     * de l'appel. `0` : sert l'instantané brut, un peu plus rapide.
     */
    enrich: z.enum(["0", "1"]).default("1"),
};

/** `/api/v1/grid` — le fournisseur est obligatoire (recherche transversale : /products/search). */
export const gridQuerySchema = z.object({
    fournisseur: z.string().min(1, "Paramètre 'fournisseur' requis"),
    gamme: z.string().min(1).optional(),
    code1: z.string().min(1).optional(),
    code2: z.string().min(1).optional(),
    code3: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    /**
     * `1` (défaut) : si le fournisseur n'a pas encore d'instantané, l'API le calcule
     * à la demande au lieu de répondre `not_ready`. C'est ce qui permet à une app ou
     * à un agent externe d'interroger n'importe quel fournisseur sans qu'un humain
     * ait ouvert la Grille avant. Le premier appel est alors plus lent (plusieurs
     * secondes) ; les suivants sont servis depuis l'instantané.
     * `0` : comportement strict, échoue vite en `not_ready`.
     */
    compute: z.enum(["0", "1"]).default("1"),
    ...sortShape,
    ...paginationShape,
});

/** `/api/v1/products/search` — `fournisseur` facultatif : c'est la recherche transversale. */
export const productSearchSchema = z.object({
    q: z.string().min(1, "Paramètre 'q' requis").max(120),
    fournisseur: z.string().min(1).optional(),
    gamme: z.string().min(1).optional(),
    ...sortShape,
    ...paginationShape,
});

export const fournisseursQuerySchema = z.object({
    search: z.string().min(1).optional(),
    /** true = uniquement les fournisseurs déjà présents dans l'instantané de grille. */
    withData: z.enum(["0", "1"]).optional(),
});

export const productDetailSchema = z.object({
    fournisseur: z.string().min(1).optional(),
    /**
     * `1` (défaut) : calcule l'instantané à la demande si le produit n'y figure pas
     * encore. Nécessite `fournisseur`, le calcul se faisant par lot fournisseur.
     */
    compute: z.enum(["0", "1"]).default("1"),
});

/**
 * Projection de champs : `?fields=codein,libelle1,totalCa`.
 *
 * Sert à alléger la réponse — un `ProductRow` complet porte les séries mensuelles
 * et les ventilations par magasin, ce qui est volumineux sur plusieurs centaines de
 * lignes. `codein` est toujours conservé pour que la ligne reste identifiable.
 */
export function pickFields<T extends object>(row: T, fields?: string): Partial<T> {
    if (!fields) return row;
    const wanted = new Set(
        fields.split(",").map((f) => f.trim()).filter(Boolean),
    );
    if (wanted.size === 0) return row;
    wanted.add("codein");
    const out: Record<string, unknown> = {};
    for (const key of wanted) {
        if (key in row) out[key] = (row as unknown as Record<string, unknown>)[key];
    }
    return out as Partial<T>;
}

/** Normalise le tri validé vers la clé attendue par grid-store. */
export function toSortKey(sort?: string): GridSortKey | undefined {
    return sort as GridSortKey | undefined;
}
