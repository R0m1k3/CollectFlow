"use server";

import { getSitesFromApi } from "@/lib/api-ff-client";
import { pgGetFournisseurs } from "@/lib/pg-ff-client";
import { getProductRows } from "./api/get-product-rows";
import type { ProductRow, GridFilters } from "@/types/grid";

/**
 * Get the list of all suppliers from PostgreSQL (fouadr1).
 */
export async function getFournisseurs() {
    return pgGetFournisseurs();
}

/**
 * Get the list of all stores (sites) from the FF Nancy API.
 */
export async function getMagasins() {
    return getSitesFromApi();
}

/**
 * Nomenclature filter is disabled — code3 is not available from the API.
 */
export async function getAvailableNomenclature() {
    return {};
}

/**
 * Retourne tous les produits d'un fournisseur.
 * Le résultat est mis en cache 5 min côté serveur (unstable_cache par fournisseur).
 * La première requête est lente (6 SQL + agrégation mémoire).
 * Toutes les requêtes suivantes dans la fenêtre de 5 min sont instantanées.
 */
export async function getGridData(
    codeFournisseur: string,
    magasin: string = "TOTAL",
    filters?: Partial<GridFilters>
): Promise<ProductRow[]> {
    return getProductRows({ codeFournisseur, magasin, filters });
}
