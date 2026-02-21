"use server";

import { FOURNISSEURS, generateMockRows } from "@/lib/mock-data";
import type { ProductRow } from "@/types/grid";

/**
 * Get the list of all unique suppliers (Mocked for now).
 */
export async function getFournisseurs() {
    // Simulating a database latency
    await new Promise((r) => setTimeout(r, 100));
    return FOURNISSEURS;
}

/**
 * Get the list of all magasins (Mocked).
 */
export async function getMagasins() {
    await new Promise((r) => setTimeout(r, 50));
    return [
        { code: "M001", nom: "BORDEAUX LAC" },
        { code: "M002", nom: "TOULOUSE BLAGNAC" },
        { code: "M003", nom: "NANTES BEAUJOIRE" },
        { code: "M004", nom: "LILLE FLANDRES" },
        { code: "M005", nom: "MARSEILLE VALENTINE" },
    ];
}

/**
 * Get grid data for a specific supplier and store (Mocked for now).
 * In SQL:
 * - If magasin === "TOTAL": SELECT SUM(quantite), AVG(marge)... GROUP BY produit_id
 * - If magasin === "M001": SELECT quantite, marge... WHERE magasin_id = 'M001'
 */
export async function getGridData(codeFournisseur: string, magasin: string = "TOTAL"): Promise<ProductRow[]> {
    // Simulating a database latency
    await new Promise((r) => setTimeout(r, 300));

    // Use the existing mock generator - passing magasin to see how it affects data
    return generateMockRows(codeFournisseur, 85);
}
