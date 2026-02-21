"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { eq, and, ne, like } from "drizzle-orm";
import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
}

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL", filters } = input;

    // ... (allowedPeriods calculation remains the same)
    const now = new Date();
    const allowedPeriods = new Set<string>();
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        allowedPeriods.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    // Build conditions
    const conditions = [
        eq(ventesProduits.codeFournisseur, codeFournisseur),
        ne(ventesProduits.periode, "TOTAL"),
        magasin !== "TOTAL" ? eq(ventesProduits.magasin, magasin) : ne(ventesProduits.magasin, "TOTAL"),
    ];

    // Hierarchical filtering
    if (filters?.code3) {
        conditions.push(eq(ventesProduits.code3, filters.code3));
    } else if (filters?.code2) {
        conditions.push(like(ventesProduits.code3, `${filters.code2}%`));
    } else if (filters?.code1) {
        conditions.push(like(ventesProduits.code3, `${filters.code1}%`));
    }

    // Get all rows for this supplier
    const rows = await db
        .select()
        .from(ventesProduits)
        .where(and(...conditions));

    // Group by codein and aggregate monthly sales + track store participation
    const productMap = new Map<string, ProductRow>();
    const storeParticipationMap = new Map<string, Map<string, Set<string>>>(); // codein -> magasin -> Set of periods

    for (const row of rows) {
        // Ignorer les données qui ne font pas partie des 12 mois complets
        if (!allowedPeriods.has(row.periode)) continue;

        const { codein, magasin, periode } = row;

        // Suivi de la participation par magasin
        if (!storeParticipationMap.has(codein)) storeParticipationMap.set(codein, new Map());
        const productStores = storeParticipationMap.get(codein)!;
        if (!productStores.has(magasin)) productStores.set(magasin, new Set());
        productStores.get(magasin)!.add(periode);

        const existing = productMap.get(codein);
        const qty = Math.abs(parseFloat(row.quantite?.toString() ?? "0"));
        const ca = Math.abs(parseFloat(row.montantMvt?.toString() ?? "0"));
        const marge = Math.abs(parseFloat(row.margeMvt?.toString() ?? "0"));

        if (existing) {
            existing.sales12m[periode] = (existing.sales12m[periode] ?? 0) + qty;
            existing.totalQuantite += qty;
            existing.totalCa += ca;
            existing.totalMarge += marge;
            existing.tauxMarge = existing.totalCa > 0 ? (existing.totalMarge / existing.totalCa) * 100 : 0;
        } else {
            productMap.set(codein, {
                codein,
                codeFournisseur: row.codeFournisseur ?? "",
                nomFournisseur: row.nomFournisseur ?? "",
                libelle1: row.libelle1 ?? "",
                gtin: row.gtin ?? "",
                reference: row.reference ?? "",
                code1: (row.code3 ?? "").slice(0, 2),
                libelleNiveau1: "Niv. 1", // À mapper plus tard
                code2: (row.code3 ?? "").slice(0, 4),
                libelleNiveau2: "Niv. 2", // À mapper plus tard
                code3: row.code3 ?? "",
                libelle3: row.libelle3 ?? "",
                codeGamme: (row.codeGamme as GammeCode | null),
                codeGammeDraft: null,
                sales12m: { [periode]: qty },
                totalQuantite: qty,
                totalCa: ca,
                totalMarge: marge,
                tauxMarge: ca > 0 ? (marge / ca) * 100 : 0,
                score: 0,
                workingStores: [],
                aiRecommendation: null,
            });
        }
    }

    // Finaliser la liste des magasins "actifs" (travaillant le produit : >= 3 mois de vente)
    for (const [codein, product] of productMap.entries()) {
        const productStores = storeParticipationMap.get(codein);
        if (productStores) {
            const workingStores: string[] = [];
            for (const [magasin, periods] of productStores.entries()) {
                if (magasin === "TOTAL") continue;
                if (periods.size >= 3) {
                    workingStores.push(magasin);
                }
            }
            product.workingStores = workingStores.sort();
        }
    }

    return computeProductScores(Array.from(productMap.values()));
}
