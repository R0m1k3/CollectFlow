"use server";

import { getSitesFromApi } from "@/lib/api-ff-client";
import { getFournisseursCached } from "@/lib/ff-cache";
import { getProductRows } from "./api/get-product-rows";
import { requireSession } from "@/lib/authz";
import type { ProductRow, GridFilters } from "@/types/grid";

/**
 * Get the list of all suppliers from PostgreSQL (fouadr1).
 */
export async function getFournisseurs() {
    await requireSession();
    // Relu à chaque navigation dans la Grille (changement de fournisseur, de
    // magasin…) : le référentiel ne change qu'avec la recopie nocturne.
    return getFournisseursCached();
}

/**
 * Get the list of all stores (sites) from the FF Nancy API.
 */
export async function getMagasins() {
    await requireSession();
    return getSitesFromApi();
}

/**
 * Nomenclature filter is disabled — code3 is not available from the API.
 * Returns an empty hierarchy so the sidebar filter is hidden gracefully.
 */
export async function getAvailableNomenclature() {
    await requireSession();
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
    await requireSession();
    return getProductRows({ codeFournisseur, magasin, filters });
}
