"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { getProductRows } from "./api/get-product-rows";
import type { ProductRow } from "@/types/grid";

/**
 * Get the list of all unique suppliers from the database.
 */
export async function getFournisseurs() {
    try {
        const results = await db
            .selectDistinct({
                code: ventesProduits.codeFournisseur,
                nom: ventesProduits.nomFournisseur,
            })
            .from(ventesProduits)
            .orderBy(ventesProduits.nomFournisseur);

        return results.map(r => ({
            code: r.code ?? "UNKNOWN",
            nom: r.nom ?? "Fournisseur Inconnu"
        }));
    } catch (error) {
        console.error("Error fetching suppliers:", error);
        return [];
    }
}

/**
 * Get the list of all magasins (stores) from the database.
 */
export async function getMagasins() {
    try {
        const results = await db
            .selectDistinct({
                code: ventesProduits.magasin,
                nom: ventesProduits.magasin, // Using code as name as no name column exists
            })
            .from(ventesProduits)
            .orderBy(ventesProduits.magasin);

        return results.map(r => ({
            code: r.code,
            nom: r.nom
        }));
    } catch (error) {
        console.error("Error fetching stores:", error);
        return [];
    }
}

/**
 * Get real product data for a specific supplier and store.
 */
export async function getGridData(codeFournisseur: string, magasin: string = "TOTAL"): Promise<ProductRow[]> {
    return getProductRows({ codeFournisseur, magasin });
}
