/**
 * CollectFlow — Tendance des ventes réseau Qlik sur 12 mois.
 *
 * Extrait de `heatmap-grid.tsx` pour être partagé entre la Grille (sparkline de
 * la colonne « Tendance / Réseau ») et la fiche produit (`/produits`).
 * Aucun changement de comportement.
 */

/**
 * Nombre de magasins du réseau La Foir'Fouille servant de dénominateur au taux
 * de présence. Constante métier : source unique pour la Grille et la fiche produit.
 */
export const NB_MAGASINS_RESEAU = 270;

export type NetworkTrend = {
    values: number[];   // quantités mensuelles, ordre chronologique
    labels: string[];   // "YYYY-MM"
    direction: "up" | "down" | "flat";
    pct: number | null; // variation modélisée (régression linéaire) sur 12 mois
    hasData: boolean;
};

/** Seuil de "forte" variation (±25%) pour distinguer hausse/forte hausse dans l'UI. */
export const TREND_STRONG = 0.25;

/**
 * Les 12 mois complets glissants au format Qlik `"YYYY-MM"`, du plus ancien au
 * plus récent. **Le mois en cours est exclu** : il est partiel, l'intégrer
 * écraserait systématiquement la tendance vers le bas.
 *
 * Même fenêtre que `getLast12Months()` (clés FF `"YYYYMM"`) et que
 * `buildGridNetworkQlikDateFilter()` (extraction Qlik) — les trois doivent
 * rester alignés.
 */
export function buildRolling12QlikMonths(now: Date = new Date()): string[] {
    const months: string[] = [];
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return months;
}

/** Seuil au-delà duquel on ne considère plus la tendance comme stable (±8%). */
export const TREND_FLAT = 0.08;

export const TREND_COLOR: Record<NetworkTrend["direction"], string> = {
    up: "#22c55e",
    down: "#ef4444",
    flat: "#94a3b8",
};

/**
 * Tendance réseau par RÉGRESSION LINÉAIRE (moindres carrés) sur les **12 mois
 * complets glissants, mois en cours exclu**.
 *
 * La fenêtre est reconstruite à partir de la date du jour (et non des clés
 * présentes dans `qteByMonth`) : c'est le seul moyen de garantir une tendance
 * réellement glissante. Deux conséquences voulues :
 *   - un mois en cours (partiel) ou un mois plus vieux que 12 mois présent dans
 *     le cache est **ignoré** — sinon la pente est faussée par un mois tronqué ;
 *   - un mois de la fenêtre **absent** du cache vaut 0 : côté Qlik, un produit
 *     non vendu sur un mois ne produit tout simplement pas de ligne.
 *
 * Une série n'est affichée que si les **12 clés sont explicitement présentes**.
 * L'extracteur Qlik écrit lui-même les mois sans faits à 0 après avoir validé
 * la fenêtre et l'égalité avec le total Qlik. Une ancienne extraction partielle
 * ne peut donc plus être présentée comme une tendance réelle.
 *
 * Utilise tous les points (robuste au bruit d'un mois isolé). L'indicateur `pct` est la
 * variation modélisée sur la période (pente × durée) rapportée à la moyenne.
 * Direction : forte hausse >+25%, hausse >+8%, stable, baisse <−8%, forte baisse <−25%.
 */
export function computeNetworkTrend(
    qteByMonth?: Record<string, number> | null,
    now: Date = new Date(),
): NetworkTrend {
    const empty: NetworkTrend = { values: [], labels: [], direction: "flat", pct: null, hasData: false };
    if (!qteByMonth) return empty;
    const labels = buildRolling12QlikMonths(now);
    const complet = labels.every((label) =>
        Object.prototype.hasOwnProperty.call(qteByMonth, label) &&
        Number.isFinite(Number(qteByMonth[label])),
    );
    if (!complet) return empty;

    const values = labels.map((l) => Number(qteByMonth[l]));
    const n = values.length;
    let pct: number | null = null;
    let direction: NetworkTrend["direction"] = "flat";
    if (n >= 3) {
        const mx = (n - 1) / 2;
        const my = values.reduce((s, v) => s + v, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (i - mx) * (values[i] - my); den += (i - mx) * (i - mx); }
        const slope = den ? num / den : 0;
        if (my > 0) {
            pct = (slope * (n - 1)) / my; // variation modélisée sur toute la période / moyenne
            direction = pct > TREND_FLAT ? "up" : pct < -TREND_FLAT ? "down" : "flat";
        } else if (slope > 0) {
            direction = "up";
        }
    } else if (n === 2 && values[0] > 0) {
        pct = (values[1] - values[0]) / values[0];
        direction = pct > TREND_FLAT ? "up" : pct < -TREND_FLAT ? "down" : "flat";
    }
    return { values, labels, direction, pct, hasData: true };
}

/** Libellé français de la tendance : « Forte hausse », « Baisse », « Stable »… */
export function trendLabel(pct: number | null): string {
    if (pct == null) return "Stable";
    if (pct > TREND_STRONG) return "Forte hausse";
    if (pct > TREND_FLAT) return "Hausse";
    if (pct < -TREND_STRONG) return "Forte baisse";
    if (pct < -TREND_FLAT) return "Baisse";
    return "Stable";
}
