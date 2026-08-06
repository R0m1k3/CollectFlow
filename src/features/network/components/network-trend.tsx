"use client";

/**
 * CollectFlow — Tendance réseau Qlik (composants partagés).
 *
 * Extrait de `features/grid/components/heatmap-grid.tsx` pour être réutilisé par
 * la page Recherche réseau. Le comportement est identique : seule la localisation
 * du code change.
 *
 * Source des données : `qteByMonth` ({ "YYYY-MM": quantité }) produit par la
 * synchronisation Qlik (mesure « Quantité N », complétée par « Quantité COMP »
 * et une passe année N-1 pour obtenir 12 mois glissants contigus).
 */

import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// Le calcul vit dans `@/lib/network-trend` (module pur, sans React) pour que
// l'API `/api/v1` expose exactement la même tendance que la Grille. On le
// réexporte ici pour ne pas changer les imports existants.
import { computeNetworkTrend, trendLabel, TREND_STRONG, type NetworkTrend } from "@/lib/network-trend";

export { computeNetworkTrend, trendLabel, TREND_STRONG };
export type { NetworkTrend };

export const TREND_COLOR: Record<NetworkTrend["direction"], string> = {
    up: "#22c55e",
    down: "#ef4444",
    flat: "#94a3b8",
};

/** Sparkline compacte 12 mois + flèche, teintée selon la tendance. */
export function TrendSparkline({ trend }: { trend: NetworkTrend }) {
    if (!trend.hasData) return <div className="text-center text-[12px]" style={{ color: "var(--text-secondary)" }}>-</div>;
    const { values, direction, pct } = trend;
    const color = TREND_COLOR[direction];
    const W = 46, H = 18, n = values.length;
    const max = Math.max(...values, 1), min = Math.min(...values, 0);
    const range = max - min || 1;
    const pts = values.map((v, i) => {
        const x = n > 1 ? (i / (n - 1)) * (W - 2) + 1 : W / 2;
        const y = H - 1 - ((v - min) / range) * (H - 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const Arrow = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
    return (
        <div className="flex flex-col items-center justify-center gap-0.5" title={pct != null ? `Tendance ${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(0)}% sur 12 mois (régression) — cliquer pour le détail` : "Tendance réseau — cliquer pour le détail"}>
            <div className="flex items-center gap-1">
                <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
                    {n > 1 && <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
                    {n === 1 && <circle cx={W / 2} cy={H / 2} r={2} fill={color} />}
                </svg>
                <Arrow className="w-3.5 h-3.5 shrink-0" style={{ color }} strokeWidth={2.5} />
            </div>
            {pct != null && (
                <span className="text-[9px] font-bold tabular-nums leading-none" style={{ color }}>
                    {pct >= 0 ? "+" : ""}{Math.round(pct * 100)}%
                </span>
            )}
        </div>
    );
}

/** "2026-01" → "01/26" pour un axe compact. */
export function fmtMonthShort(lab: string): string {
    const [y, m] = lab.split("-");
    return `${m ?? lab}/${(y ?? "").slice(2)}`;
}

/** Courbe unique des ventes réseau mensuelles (SVG). */
export function NetworkLineChart({ labels, values, color }: { labels: string[]; values: number[]; color: string }) {
    const W = 460, H = 200;
    const padL = 10, padR = 10, padT = 22, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = values.length;
    const maxV = Math.max(...values, 1);
    const x = (i: number) => (n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2);
    const y = (v: number) => padT + plotH - (v / maxV) * plotH;
    const linePts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const areaPts = `${padL},${padT + plotH} ${linePts} ${(padL + plotW).toFixed(1)},${(padT + plotH).toFixed(1)}`;
    return (
        <div className="mt-3 w-full overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 380 }} role="img" aria-label="Ventes réseau mensuelles">
                {/* ligne de base */}
                <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="var(--border)" strokeWidth={1} />
                {/* aire douce sous la courbe */}
                {n > 1 && <polygon points={areaPts} fill={color} opacity={0.08} />}
                {/* courbe */}
                {n > 1 && <polyline points={linePts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                {values.map((v, i) => (
                    <g key={labels[i]}>
                        <circle cx={x(i)} cy={y(v)} r={2.6} fill={color} />
                        {/* quantité au-dessus du point */}
                        <text x={x(i)} y={y(v) - 6} textAnchor="middle" fontSize={9} fontWeight={700} fill="var(--text-primary)">
                            {Math.round(v).toLocaleString("fr-FR")}
                        </text>
                        {/* mois sous l'axe */}
                        <text x={x(i)} y={H - 10} textAnchor="middle" fontSize={8} fill="var(--text-muted)">
                            {fmtMonthShort(labels[i])}
                        </text>
                    </g>
                ))}
            </svg>
        </div>
    );
}
