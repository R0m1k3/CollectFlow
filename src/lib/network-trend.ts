/**
 * CollectFlow — Tendance réseau (calcul pur, sans React).
 *
 * Isolé du composant d'affichage (`features/network/components/network-trend.tsx`)
 * pour être utilisable **côté serveur** : l'API `/api/v1` expose ainsi la même
 * tendance que celle affichée dans la Grille, au lieu de laisser chaque appelant
 * la recalculer — et diverger.
 *
 * Source : `qteByMonth` ({ "YYYY-MM": quantité }) produit par la synchronisation Qlik.
 */

export type TrendDirection = "up" | "down" | "flat";

export type NetworkTrend = {
    values: number[];   // quantités mensuelles, ordre chronologique
    labels: string[];   // "YYYY-MM"
    direction: TrendDirection;
    pct: number | null; // variation modélisée (régression linéaire) sur 12 mois
    hasData: boolean;
};

/** Seuil de "forte" variation (±25%) pour distinguer hausse/forte hausse. */
export const TREND_STRONG = 0.25;

/**
 * Tendance réseau par RÉGRESSION LINÉAIRE (moindres carrés) sur les 12 derniers mois.
 * Utilise tous les points (robuste au bruit d'un mois isolé). L'indicateur `pct` est la
 * variation modélisée sur la période (pente × durée) rapportée à la moyenne.
 * Direction : hausse >+8%, stable, baisse <−8%.
 */
export function computeNetworkTrend(qteByMonth?: Record<string, number> | null): NetworkTrend {
    const empty: NetworkTrend = { values: [], labels: [], direction: "flat", pct: null, hasData: false };
    if (!qteByMonth) return empty;
    let labels = Object.keys(qteByMonth).sort(); // "YYYY-MM" trie chronologiquement
    if (labels.length === 0) return empty;
    labels = labels.slice(-12); // 12 derniers mois
    const values = labels.map((l) => Number(qteByMonth[l]) || 0);
    const n = values.length;
    let pct: number | null = null;
    let direction: TrendDirection = "flat";
    if (n >= 3) {
        const mx = (n - 1) / 2;
        const my = values.reduce((s, v) => s + v, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (i - mx) * (values[i] - my); den += (i - mx) * (i - mx); }
        const slope = den ? num / den : 0;
        if (my > 0) {
            pct = (slope * (n - 1)) / my; // variation modélisée sur toute la période / moyenne
            direction = pct > 0.08 ? "up" : pct < -0.08 ? "down" : "flat";
        } else if (slope > 0) {
            direction = "up";
        }
    } else if (n === 2 && values[0] > 0) {
        pct = (values[1] - values[0]) / values[0];
        direction = pct > 0.08 ? "up" : pct < -0.08 ? "down" : "flat";
    }
    return { values, labels, direction, pct, hasData: true };
}

/** Libellé français de la tendance (« Forte hausse », « Stable »…). */
export function trendLabel(pct: number): string {
    if (pct > TREND_STRONG) return "Forte hausse";
    if (pct > 0.08) return "Hausse";
    if (pct < -TREND_STRONG) return "Forte baisse";
    if (pct < -0.08) return "Baisse";
    return "Stable";
}
