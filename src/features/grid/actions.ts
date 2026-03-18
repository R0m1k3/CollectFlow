"use server";

import { getFournisseursFromApi, getSitesFromApi } from "@/lib/api-ff-client";
import { getProductRows } from "./api/get-product-rows";
import type { ProductRow, GridFilters } from "@/types/grid";

/**
 * Get the list of all suppliers from the FF Nancy API.
 */
export async function getFournisseurs() {
    return getFournisseursFromApi();
}

/**
 * Get the list of all stores (sites) from the FF Nancy API.
 */
export async function getMagasins() {
    return getSitesFromApi();
}

/**
 * Nomenclature filter is disabled — code3 is not available from the API.
 * Returns an empty hierarchy so the sidebar filter is hidden gracefully.
 */
export async function getAvailableNomenclature() {
    return {};
}

/**
 * Get product data for a specific supplier and store.
 */
export async function getGridData(
    codeFournisseur: string,
    magasin: string = "TOTAL",
    filters?: Partial<GridFilters>
): Promise<ProductRow[]> {
    return getProductRows({ codeFournisseur, magasin, filters });
}
