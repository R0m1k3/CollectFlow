/**
 * Complément des chiffres d'un magasin par l'API FF (ventes mensuelles).
 *
 * Le calcul SQL de la Grille peut manquer les ventes d'un magasin pour certains
 * articles (quantité à 0 pour ce magasin). L'API FF les connaît : on en tire,
 * pour ces articles seulement, les séries et totaux du magasin.
 *
 * Module sans dépendance d'exécution : utilisé côté serveur (calcul du
 * complément) comme côté navigateur (application aux lignes affichées).
 */

import type { ProductRow } from "@/types/grid";
import type { FfMensuelEntry } from "@/lib/api-ff-client";

/** Chiffres d'un article pour le magasin complété. */
export interface StorePatchEntry {
    codein: string;
    /** Ventes par mois (« YYYYMM »). */
    sales: Record<string, number>;
    /** Stock de fin de mois, reporté sur les mois sans donnée. */
    stock: Record<string, number>;
    receptions: Record<string, number>;
    quantite: number;
    ca: number;
    marge: number;
}

export interface StorePatch {
    magasin: string;
    /** Fenêtre des 12 mois du calcul : un complément d'un autre mois est ignoré. */
    periods: string[];
    entries: StorePatchEntry[];
}

/** Articles à compléter : connus de FF (noid) et sans aucune vente SQL dans ce magasin. */
export function storePatchCandidates(rows: ProductRow[], magasin: string): ProductRow[] {
    return rows.filter((row) => !!row.noid && (row.quantiteByStore?.[magasin] ?? 0) === 0);
}

/** Chiffres du magasin tirés de l'API, pour les articles où elle montre des ventes. */
export function buildStorePatchEntries(
    retenus: ProductRow[],
    magasin: string,
    periods: string[],
    mensuel: Map<string, FfMensuelEntry[]>,
): StorePatchEntry[] {
    const resultat: StorePatchEntry[] = [];
    for (const row of retenus) {
        const entries = (mensuel.get(row.codein) ?? []).filter((entry) => entry.site === magasin);
        if (entries.length === 0) continue;

        const byPeriod = new Map<string, { qty: number; ca: number; marge: number; stock: number; receptions: number }>();
        for (const entry of entries) {
            const period = entry.mois.replace("-", "");
            if (!periods.includes(period)) continue;
            // qte_vendue / ca_ht sont NÉGATIFS côté API (ventes nettes) : on
            // les nie au lieu de Math.abs pour que les retours restent déduits.
            const qty = -(Number(entry.ventes?.qte_vendue ?? 0) || 0);
            const ca = -(Number(entry.ventes?.ca_ht ?? 0) || 0);
            const marge = Number(entry.ventes?.marge ?? 0) || 0;
            const stock = Number(entry.stock_fin_mois ?? 0) || 0;
            const receptions = Number(entry.receptions?.qte_recue ?? 0) || 0;
            byPeriod.set(period, { qty, ca, marge, stock, receptions });
        }

        const apiQty = [...byPeriod.values()].reduce((sum, value) => sum + value.qty, 0);
        if (apiQty === 0) continue;

        const e: StorePatchEntry = { codein: row.codein, sales: {}, stock: {}, receptions: {}, quantite: 0, ca: 0, marge: 0 };
        let lastStock = 0;
        for (const period of periods) {
            const value = byPeriod.get(period);
            e.sales[period] = value?.qty ?? 0;
            e.receptions[period] = value?.receptions ?? 0;
            if (value) lastStock = value.stock;
            e.stock[period] = lastStock;
            e.quantite += value?.qty ?? 0;
            e.ca += value?.ca ?? 0;
            e.marge += value?.marge ?? 0;
        }
        resultat.push(e);
    }
    return resultat;
}

/**
 * Application historique, côté serveur (`/api/grid/rows?magasin=…`) : corrige le
 * magasin ET reporte les écarts sur les totaux « tous magasins » de la ligne.
 * Renvoie le nombre de lignes corrigées.
 */
export function applyStorePatchInPlace(
    rows: ProductRow[],
    magasin: string,
    periods: string[],
    entries: StorePatchEntry[],
): number {
    const parCode = new Map(entries.map((e) => [e.codein, e]));
    let corrigees = 0;
    for (const row of rows) {
        const e = parCode.get(row.codein);
        if (!e) continue;

        row.sales12mByStore ??= {};
        row.stock12mByStore ??= {};
        row.receptions12mByStore ??= {};
        row.caByStore ??= {};
        row.quantiteByStore ??= {};
        row.margeByStore ??= {};
        row.sales12mByStore[magasin] ??= {};
        row.stock12mByStore[magasin] ??= {};
        row.receptions12mByStore[magasin] ??= {};

        for (const period of periods) {
            const currentQty = row.sales12mByStore[magasin][period] ?? 0;
            const nextQty = e.sales[period] ?? 0;
            row.sales12mByStore[magasin][period] = nextQty;
            row.receptions12mByStore[magasin][period] = e.receptions[period] ?? 0;
            row.stock12mByStore[magasin][period] = e.stock[period] ?? 0;
            row.sales12m[period] = (row.sales12m[period] ?? 0) + (nextQty - currentQty);
        }

        const deltaTotalQty = e.quantite - (row.quantiteByStore[magasin] ?? 0);
        const deltaTotalCa = e.ca - (row.caByStore[magasin] ?? 0);
        const deltaTotalMarge = e.marge - (row.margeByStore[magasin] ?? 0);

        row.quantiteByStore[magasin] = e.quantite;
        row.caByStore[magasin] = e.ca;
        row.margeByStore[magasin] = e.marge;
        row.totalQuantite += deltaTotalQty;
        row.totalCa += deltaTotalCa;
        row.totalMarge += deltaTotalMarge;
        row.tauxMarge = row.totalCa > 0 ? (row.totalMarge / row.totalCa) * 100 : 0;
        if (!row.workingStores.includes(magasin)) row.workingStores.push(magasin);
        corrigees++;
    }
    return corrigees;
}

/**
 * Application dans le navigateur : nouvelle ligne, chiffres du magasin seuls.
 * Les totaux « tous magasins » ne bougent pas, pour que la vue « Nos 2
 * magasins » reste identique quel que soit le magasin consulté avant.
 */
export function withStorePatch(row: ProductRow, magasin: string, e: StorePatchEntry): ProductRow {
    return {
        ...row,
        sales12mByStore: { ...row.sales12mByStore, [magasin]: e.sales },
        stock12mByStore: { ...row.stock12mByStore, [magasin]: e.stock },
        receptions12mByStore: { ...row.receptions12mByStore, [magasin]: e.receptions },
        quantiteByStore: { ...row.quantiteByStore, [magasin]: e.quantite },
        caByStore: { ...row.caByStore, [magasin]: e.ca },
        margeByStore: { ...row.margeByStore, [magasin]: e.marge },
        workingStores: row.workingStores.includes(magasin) ? row.workingStores : [...row.workingStores, magasin],
    };
}
