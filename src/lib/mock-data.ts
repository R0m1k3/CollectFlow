import type { ProductRow, GammeCode } from "@/types/grid";
import { computeProductScores } from "@/lib/score-engine";

const FOURNISSEURS = Array.from({ length: 125 }).map((_, i) => ({
    code: `F${String(i + 1).padStart(3, "0")}`,
    nom: [
        "HENKEL DISTRIBUTION", "GLAMA INTERNATIONAL", "FRANCO & FILS", "L'ORÉAL PARIS", "UNILEVER SERVICES",
        "PROCTER & GAMBLE", "JOHNSON & JOHNSON", "NESTLÉ RETAIL", "DANONE DISTRIBUTION", "FERRERO FRANCE"
    ][i % 10] + (i > 9 ? ` - Entrepôt ${Math.floor(i / 10)}` : "")
}));

const GAMMES: GammeCode[] = ["A", "A", "A", "B", "B", "C", "Z"];

const NOMENCLATURES = [
    { code: "320211", libelle: "Entretien Maison" },
    { code: "310105", libelle: "Hygiène Corporelle" },
    { code: "410203", libelle: "Cosmétiques Femme" },
    { code: "220401", libelle: "Alimentation Bio" },
    { code: "510302", libelle: "Bricolage & Outillage" },
];

const PRODUITS = [
    "Lessive Liquide 3L", "Gel Douche Vanille 500ml", "Shampoing Éclat 400ml",
    "Crème Hydratante SPF50", "Désinfectant Multi-Surface 1L", "Liquide Vaisselle Citron 750ml",
    "Déodorant Bille 50ml", "Après-Shampooing 300ml", "Mousse Rasage 200ml",
    "Dentifrice Blancheur 100ml", "Savon Solide Surgras 100g", "Crème Mains Nourrissante 75ml",
    "Nettoyant WC 500ml", "Assouplissant Fleurs Blanches 2L", "Spray Cuisine Dégraissant",
    "Gel Hydroalcoolique 500ml", "Lingettes Bébé x72", "Couches T4 x44",
    "Lait Corps Karité 400ml", "Masque Visage Argile 100ml", "Fond de Teint N°03",
    "Rouge à Lèvres Corail", "Mascara Allongeant Noir", "Eyeliner Fin Brun",
    "Vernis Ongles Rose", "Blush Pêche Doux", "Palette Ombres 12 teintes",
    "Huile Corps Éclat 150ml", "Sérum Anti-Âge 30ml", "Contour Yeux 15ml",
];

function rnd(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateSales12m(): Record<string, number> {
    const sales: Record<string, number> = {};
    const now = new Date(2026, 1, 1); // Feb 2026
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
        // Simulate seasonality + some zeros
        const base = rnd(0, 200);
        sales[key] = base < 30 ? 0 : base;
    }
    return sales;
}

export function generateMockRows(codeFournisseur: string = "F001", count: number = 80): ProductRow[] {
    const rows: ProductRow[] = [];
    const fournisseur = FOURNISSEURS.find((f) => f.code === codeFournisseur) ?? FOURNISSEURS[0];

    for (let i = 0; i < count; i++) {
        const sales12m = generateSales12m();
        const totalQuantite = Object.values(sales12m).reduce((s, v) => s + v, 0);
        const prixUnitaire = rnd(3, 45);
        const totalCa = totalQuantite * prixUnitaire * (1 + rnd(0, 30) / 100);
        const tauxMarge = rnd(12, 58);
        const totalMarge = totalCa * tauxMarge / 100;
        const nomenclature = NOMENCLATURES[i % NOMENCLATURES.length];
        const gamme = GAMMES[Math.floor(Math.random() * GAMMES.length)];

        rows.push({
            codein: `${fournisseur.code}-${String(i + 1).padStart(4, "0")}`,
            codeFournisseur: fournisseur.code,
            nomFournisseur: fournisseur.nom,
            libelle1: PRODUITS[i % PRODUITS.length],
            gtin: `340${String(rnd(100000000, 999999999))}`,
            reference: `REF${String(rnd(10000, 99999))}`,
            code3: nomenclature.code,
            libelle3: nomenclature.libelle,
            codeGamme: gamme,
            codeGammeDraft: null,
            sales12m,
            totalQuantite,
            totalCa: Math.round(totalCa * 100) / 100,
            totalMarge: Math.round(totalMarge * 100) / 100,
            tauxMarge,
            score: 0, // Computed below by computeProductScores
            aiRecommendation: null,
        });
    }
    return computeProductScores(rows);
}

export { FOURNISSEURS };
