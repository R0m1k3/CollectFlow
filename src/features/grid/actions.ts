"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { sql } from "drizzle-orm";
import { getProductRows } from "./api/get-product-rows";
import type { ProductRow, GridFilters } from "@/types/grid";

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
 * Get the list of all unique nomenclature levels available in the database.
 */
export async function getAvailableNomenclature() {
    try {
        const results = await db
            .select({
                code3: ventesProduits.code3,
                libelle3: ventesProduits.libelle3,
            })
            .from(ventesProduits)
            .where(sql`${ventesProduits.code3} IS NOT NULL`)
            .groupBy(ventesProduits.code3, ventesProduits.libelle3);

        const hierarchy: Record<string, { label: string, children: Record<string, { label: string, children: { code: string, label: string }[] }> }> = {};

        // Mapping basique des libellés Niv 1 et 2
        const L1_LABELS: Record<string, string> = {
            "30": "ÉPICERIE",
            "31": "CRÉMERIE / FRAIS",
            "32": "LIQUIDES",
            "33": "DPH",
            "34": "BAZAR",
            "35": "TEXTILE",
        };

        results.forEach(r => {
            const c3 = r.code3 || "";
            const l3 = r.libelle3 || "";
            if (c3.length < 2) return;

            const c1 = c3.slice(0, 2);
            const c2 = c3.slice(0, 4);

            if (!hierarchy[c1]) {
                hierarchy[c1] = { label: L1_LABELS[c1] || `Niveau 1 (${c1})`, children: {} };
            }
            if (!hierarchy[c1].children[c2]) {
                hierarchy[c1].children[c2] = { label: `Niveau 2 (${c2})`, children: [] };
            }
            hierarchy[c1].children[c2].children.push({ code: c3, label: l3 });
        });

        return hierarchy;
    } catch (error) {
        console.error("Error fetching nomenclature:", error);
        return {};
    }
}

/**
 * Get real product data for a specific supplier and store.
 */
export async function getGridData(
    codeFournisseur: string,
    magasin: string = "TOTAL",
    filters?: Partial<GridFilters>
): Promise<ProductRow[]> {
    return getProductRows({ codeFournisseur, magasin, filters });
}
