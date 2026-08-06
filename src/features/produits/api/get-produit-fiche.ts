import "server-only";

import {
    pgGetProduitDetail,
    pgGetCodeinByCodeCentrale,
    pgGetFournisseursByCodein,
    pgGetStockByCodein,
    pgGetCommandesByCodein,
    pgGetGammeHistoryByCodein,
    pgGetMensuelByCodein,
} from "@/lib/pg-ff-client";
import { buildLast12MonthsRange } from "@/lib/api-ff-client";
import { getNetworkMetricsByCodeCentrale } from "@/lib/qlik-network-cache";
import type { ProduitFiche, ProduitMois, ProduitTotaux } from "@/features/produits/types";

/** Les 12 clés de mois "YYYYMM" glissantes, mois courant exclu. */
function buildMonthKeys(): string[] {
    const months: string[] = [];
    const now = new Date();
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return months;
}

function emptyMois(mois: string): ProduitMois {
    return { mois, qte: 0, ca: 0, marge: 0, stockFinMois: 0, qteRecue: 0 };
}

function totauxFrom(rows: ProduitMois[]): ProduitTotaux {
    const qte = rows.reduce((s, r) => s + r.qte, 0);
    const ca = rows.reduce((s, r) => s + r.ca, 0);
    const marge = rows.reduce((s, r) => s + r.marge, 0);
    return { qte, ca, marge, tauxMarge: ca > 0 ? (marge / ca) * 100 : 0 };
}

/**
 * Assemble la fiche d'un produit **à partir de son code centrale** : c'est la
 * clé du réseau Qlik, seule identité disponible pour un produit que le réseau
 * travaille mais que Nancy ne référence pas.
 *
 * Si le catalogue Nancy connaît ce code centrale, on rattache toute la partie
 * locale (identité, fournisseurs, stock, gammes, 12 mois glissants de ventes).
 * Sinon la fiche reste purement réseau, ce qui est un cas parfaitement normal
 * depuis la recherche Qlik.
 *
 * Renvoie `null` uniquement si ni Qlik ni le catalogue ne connaissent le code.
 */
export async function getProduitFicheByCodeCentrale(codeCentrale: string): Promise<ProduitFiche | null> {
    const cleaned = codeCentrale.trim();
    if (!cleaned) return null;

    const codein = await pgGetCodeinByCodeCentrale(cleaned);
    if (codein) return getProduitFiche(codein);

    // Produit réseau pur : aucune donnée locale à assembler.
    const map = await getNetworkMetricsByCodeCentrale([cleaned]);
    const reseau = map.get(cleaned) ?? null;
    if (!reseau) return null;

    const { dateDebut, dateFin } = buildLast12MonthsRange();
    const months = buildMonthKeys();
    const mensuelTotal: Record<string, ProduitMois> = {};
    for (const m of months) mensuelTotal[m] = emptyMois(m);

    return {
        detail: null,
        codeCentrale: cleaned,
        libelleReseau: reseau.libelleReseau ?? "",
        fournisseurReseau: reseau.fournisseurReseau ?? "",
        fournisseurs: [],
        stock: [],
        commandesEnCours: 0,
        gammes: [],
        months,
        mensuelTotal,
        mensuelParSite: {},
        totaux: totauxFrom(months.map((m) => mensuelTotal[m])),
        totauxParSite: {},
        sitesActifs: [],
        reseau,
        periode: { dateDebut, dateFin },
    };
}

/**
 * Assemble la fiche complète d'un produit : identité, fournisseurs, stock,
 * gammes, 12 mois glissants de ventes (total et par magasin) et métriques
 * réseau Qlik.
 *
 * Renvoie `null` si le codein est inconnu du catalogue FF.
 */
export async function getProduitFiche(codein: string): Promise<ProduitFiche | null> {
    const cleaned = codein.trim();
    if (!cleaned) return null;

    const detail = await pgGetProduitDetail(cleaned);
    if (!detail) return null;

    const { dateDebut, dateFin } = buildLast12MonthsRange();

    const [fournisseurs, stock, commandesEnCours, gammes, mensuelRows] = await Promise.all([
        pgGetFournisseursByCodein(cleaned),
        pgGetStockByCodein(cleaned),
        pgGetCommandesByCodein(cleaned),
        pgGetGammeHistoryByCodein(cleaned),
        pgGetMensuelByCodein(cleaned, dateDebut, dateFin),
    ]);

    const months = buildMonthKeys();
    const allowed = new Set(months);

    const mensuelTotal: Record<string, ProduitMois> = {};
    const mensuelParSite: Record<string, Record<string, ProduitMois>> = {};
    for (const m of months) mensuelTotal[m] = emptyMois(m);

    // Mois réellement présents dans les mouvements. Indispensable pour distinguer
    // « pas de mouvement ce mois-là » (→ report du stock précédent) de « stock
    // effectivement nul » — c'est la convention de la Grille.
    const moisAvecDonnees = new Set<string>();
    const moisAvecDonneesParSite = new Map<string, Set<string>>();

    for (const row of mensuelRows) {
        // SQL renvoie "YYYY-MM", la timeline de l'app utilise "YYYYMM".
        const mois = row.mois.replace("-", "");
        if (!allowed.has(mois)) continue;
        const site = String(row.site).trim();

        const qte = Number(row.qte_vendue) || 0;
        const ca = Number(row.ca_ht) || 0;
        const marge = Number(row.marge) || 0;
        const stockFinMois = Number(row.stock_fin_mois) || 0;
        const qteRecue = Number(row.qte_recue) || 0;

        moisAvecDonnees.add(mois);
        const tot = mensuelTotal[mois];
        tot.qte += qte;
        tot.ca += ca;
        tot.marge += marge;
        tot.stockFinMois += stockFinMois;
        tot.qteRecue += qteRecue;

        mensuelParSite[site] ??= Object.fromEntries(months.map((m) => [m, emptyMois(m)]));
        if (!moisAvecDonneesParSite.has(site)) moisAvecDonneesParSite.set(site, new Set());
        moisAvecDonneesParSite.get(site)!.add(mois);
        const cell = mensuelParSite[site][mois];
        cell.qte += qte;
        cell.ca += ca;
        cell.marge += marge;
        // Le SQL donne déjà le stock du dernier mouvement du mois pour ce site.
        cell.stockFinMois = stockFinMois;
        cell.qteRecue += qteRecue;
    }

    // Report du stock de fin de mois sur les mois SANS mouvement (carry-forward),
    // même convention que la Grille : un mois sans mouvement conserve le stock du
    // mois précédent, alors qu'un mois avec mouvements et un stock nul reste à 0.
    const carryForward = (serie: Record<string, ProduitMois>, avecDonnees: Set<string>) => {
        let last = 0;
        for (const m of months) {
            if (avecDonnees.has(m)) last = serie[m].stockFinMois;
            else serie[m].stockFinMois = last;
        }
    };
    carryForward(mensuelTotal, moisAvecDonnees);
    for (const [site, bySite] of Object.entries(mensuelParSite)) {
        carryForward(bySite, moisAvecDonneesParSite.get(site) ?? new Set());
    }

    const totaux = totauxFrom(months.map((m) => mensuelTotal[m]));
    const totauxParSite: Record<string, ProduitTotaux> = {};
    for (const [site, bySite] of Object.entries(mensuelParSite)) {
        totauxParSite[site] = totauxFrom(months.map((m) => bySite[m]));
    }

    const sitesActifs = Object.entries(totauxParSite)
        .filter(([, t]) => t.qte > 0)
        .map(([site]) => site)
        .sort();

    // Métriques réseau Qlik (jointure par code centrale).
    let reseau = null;
    if (detail.code_centrale) {
        const map = await getNetworkMetricsByCodeCentrale([detail.code_centrale]);
        reseau = map.get(detail.code_centrale) ?? null;
    }

    return {
        detail,
        codeCentrale: detail.code_centrale ?? "",
        libelleReseau: reseau?.libelleReseau ?? "",
        fournisseurReseau: reseau?.fournisseurReseau ?? "",
        fournisseurs,
        stock,
        commandesEnCours,
        gammes,
        months,
        mensuelTotal,
        mensuelParSite,
        totaux,
        totauxParSite,
        sitesActifs,
        reseau,
        periode: { dateDebut, dateFin },
    };
}
