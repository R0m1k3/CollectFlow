"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { eq, and, ne } from "drizzle-orm";
import type { ProductRow, GammeCode } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
}

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL" } = input;

    // Calculer les 12 derniers mois COMPLETS (excluant le mois en cours)
    const allowedPeriods = new Set<string>();
    const now = new Date();
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        allowedPeriods.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    // Get all rows for this supplier (excluding the synthetic TOTAL period)
    const rows = await db
        .select()
        .from(ventesProduits)
        .where(
            and(
                eq(ventesProduits.codeFournisseur, codeFournisseur),
                ne(ventesProduits.periode, "TOTAL"),
                magasin !== "TOTAL" ? eq(ventesProduits.magasin, magasin) : ne(ventesProduits.magasin, "TOTAL"),
            )
        );

    // Group by codein and aggregate monthly sales
    const productMap = new Map<string, ProductRow>();

    for (const row of rows) {
        // Ignorer les données qui ne font pas partie des 12 mois complets
        if (!allowedPeriods.has(row.periode)) continue;

        const existing = productMap.get(row.codein);
        const monthKey = row.periode;
        const qty = Math.abs(parseFloat(row.quantite?.toString() ?? "0"));
        const ca = Math.abs(parseFloat(row.montantMvt?.toString() ?? "0"));
        const marge = Math.abs(parseFloat(row.margeMvt?.toString() ?? "0"));

        if (existing) {
            existing.sales12m[monthKey] = (existing.sales12m[monthKey] ?? 0) + qty;
            existing.totalQuantite += qty;
            existing.totalCa += ca;
            existing.totalMarge += marge;
            existing.tauxMarge = existing.totalCa > 0 ? (existing.totalMarge / existing.totalCa) * 100 : 0;
        } else {
            productMap.set(row.codein, {
                codein: row.codein,
                codeFournisseur: row.codeFournisseur ?? "",
                nomFournisseur: row.nomFournisseur ?? "",
                libelle1: row.libelle1 ?? "",
                gtin: row.gtin ?? "",
                reference: row.reference ?? "",
                code3: row.code3 ?? "",
                libelle3: row.libelle3 ?? "",
                codeGamme: (row.codeGamme as GammeCode | null),
                codeGammeDraft: null,
                sales12m: { [monthKey]: qty },
                totalQuantite: qty,
                totalCa: ca,
                totalMarge: marge,
                tauxMarge: ca > 0 ? (marge / ca) * 100 : 0,
                score: 0,
                aiRecommendation: null,
            });
        }
    }

    return computeProductScores(Array.from(productMap.values()));
}
