"use server";

import { getSitesFromApi } from "@/lib/api-ff-client";
import { pgGetFournisseurs } from "@/lib/pg-ff-client";
import { getProductRows, type GetProductRowsResult } from "./api/get-product-rows";
import type { GridFilters } from "@/types/grid";

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
 * La charge est paginée (renvoie la première page en SSR) pour empêcher le figeage du thread principal UI.
 */
export async function getGridData(
    codeFournisseur: string,
    magasin: string = "TOTAL",
    filters?: Partial<GridFilters>,
    page: number = 0,
    pageSize: number = 200,
): Promise<GetProductRowsResult> {
    return getProductRows({ codeFournisseur, magasin, filters, page, pageSize });
}
