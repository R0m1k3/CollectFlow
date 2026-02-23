"use server";

import { db } from "@/db";
import { ventesProduits } from "@/db/schema";
import { eq, and, ne, like, sql } from "drizzle-orm";
import type { ProductRow, GammeCode, GridFilters } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";

let isSchemaInitialized = false;

interface GetProductRowsInput {
    codeFournisseur: string;
    magasin?: string;
    filters?: Partial<GridFilters>;
}

export async function getProductRows(input: GetProductRowsInput): Promise<ProductRow[]> {
    const { codeFournisseur, magasin = "TOTAL", filters } = input;

    // Self-healing: Ensure codeGammeInit column exists and is populated
    if (!isSchemaInitialized) {
        try {
            await db.execute(sql`
                ALTER TABLE ventes_produits 
                ADD COLUMN IF NOT EXISTS code_gamme_init VARCHAR(20)
            `);
            await db.execute(sql`
                UPDATE ventes_produits 
                SET code_gamme_init = code_gamme 
                WHERE code_gamme_init IS NULL
            `);
            isSchemaInitialized = true;
            console.log("[Schema] codeGammeInit initialized successfully.");
        } catch (err) {
            console.error("[Schema] Failed to initialize codeGammeInit:", err);
            // We continue anyway, the mapping fallback will handle it for the UI
        }
    }

    // ... (allowedPeriods calculation remains the same)
    const now = new Date();
    const allowedPeriods = new Set<string>();
    for (let i = 12; i >= 0; i--) { // i >= 0 au lieu de 1 pour inclure le mois en cours
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
            const c3 = row.code3 || "";
            const c1 = c3.slice(0, 2);
            const c2 = c3.slice(0, 4);

            const NOMENCLATURE_LABELS: Record<string, string> = {
                "20": "LIQUIDES",
                "30": "ÉPICERIE",
                "40": "DPH",
                "50": "BAZAR",
                "60": "TEXTILE",
                "70": "FRAIS",
                // Rayons
                "2001": "EAUX", "2002": "JUS DE FRUITS", "2003": "SODAS / BOUILLONS", "2004": "BIERES", "2005": "VINS", "2006": "CIDRES", "2007": "APERITIFS", "2008": "ALCOOLS",
                "3001": "ÉPICERIE SALÉE", "3002": "ÉPICERIE SUCRÉE", "3003": "PETIT DÉJEUNER", "3004": "CONSERVES", "3005": "PLAT CUISINES",
                "4001": "HYGIÈNE", "4002": "ENTRETIEN", "4003": "PARFUMERIE",
                "5001": "BRICOLAGE", "5002": "MAISON", "5003": "LOISIRS", "5004": "JARDIN",
                "7001": "FRUITS ET LEGUMES", "7002": "CREMERIE", "7003": "VOLAILLE", "7004": "CHARCUTERIE", "7005": "TRAITEUR", "7006": "BOULANGERIE",
            };

            productMap.set(codein, {
                codein,
                codeFournisseur: row.codeFournisseur ?? "",
                nomFournisseur: row.nomFournisseur ?? "",
                libelle1: row.libelle1 ?? "",
                gtin: row.gtin ?? "",
                reference: row.reference ?? "",
                code1: c1,
                libelleNiveau1: NOMENCLATURE_LABELS[c1] || `Secteur ${c1}`,
                code2: c2,
                libelleNiveau2: NOMENCLATURE_LABELS[c2] || `Rayon ${c2}`,
                code3: c3,
                libelle3: row.libelle3 ?? "",
                codeGamme: (row.codeGamme as GammeCode | null),
                codeGammeInit: (row.codeGammeInit as GammeCode | null) ?? (row.codeGamme as GammeCode | null),
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
