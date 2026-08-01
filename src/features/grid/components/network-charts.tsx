"use client";

/**
 * CollectFlow — Graphiques réseau (SVG fait main, aucune librairie de charts).
 *
 * Extraits de `heatmap-grid.tsx` pour être partagés entre la Grille et la fiche
 * produit (`/produits`). Aucun changement de comportement.
 */

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { fmtMonthShort } from "@/features/grid/lib/months";
import { TREND_COLOR, type NetworkTrend } from "@/features/grid/lib/network-trend";

/** Sparkline compacte 12 mois + flèche, teintée selon la tendance. */
export function TrendSparkline({ trend }: { trend: NetworkTrend }) {
    if (!trend.hasData) return <div className="text-center text-[12px]" style={{ color: "var(--text-secondary)" }}>-</div>;
    const { values, direction, pct, nouveau } = trend;
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
        <div className="flex flex-col items-center justify-center gap-0.5" title={pct != null
                ? `Tendance ${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(0)}% : 4 derniers mois vs 4 premiers — cliquer pour le détail`
                : nouveau
                    ? "Nouveau : aucune vente sur les 4 premiers mois de la fenêtre — cliquer pour le détail"
                    : "Tendance réseau — cliquer pour le détail"}>
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
            {pct == null && nouveau && (
                <span className="text-[9px] font-bold leading-none" style={{ color }}>Nouveau</span>
            )}
        </div>
    );
}

/** Couleur par défaut de la courbe « magasins vendeurs » : indigo franc. */
export const STORES_COLOR = "#6366f1";
/** Repli chaud, quand la courbe des quantités est elle-même dans les tons froids. */
export const STORES_COLOR_ALT = "#f59e0b";

/**
 * Couleur de la courbe « magasins » garantie DISTINCTE de celle des quantités.
 *
 * La courbe des quantités prend la couleur de la tendance : vert (#22c55e),
 * rouge (#ef4444) ou gris-bleu (#94a3b8) quand elle est stable. L'indigo se
 * détache nettement du vert et du rouge, mais il est trop proche du gris-bleu —
 * or « stable » est le cas le plus fréquent. Dans ce cas précis on bascule sur
 * l'ambre : gris froid contre orange chaud, impossible à confondre.
 */
export function storesColorFor(couleurQuantites: string): string {
    return couleurQuantites.toLowerCase() === TREND_COLOR.flat.toLowerCase()
        ? STORES_COLOR_ALT
        : STORES_COLOR;
}

/**
 * Ventes réseau mensuelles, avec en option le nombre de magasins vendeurs.
 *
 * ⚠️ DEUX BANDES SÉPARÉES, PAS DEUX COURBES SUPERPOSÉES.
 *
 * La superposition a été essayée et rejetée à l'usage : les quantités se
 * comptent en milliers, les magasins plafonnent à ~270. Sur une échelle commune
 * la courbe des magasins s'écrase sur l'axe ; sur deux échelles superposées elle
 * passe AU-DESSUS de celle des quantités, ce qui se lit spontanément comme « il
 * y a plus de magasins que de ventes » — un contresens.
 *
 * ⚠️ LA DENSITÉ EST LE VRAI ENNEMI. Une première version imprimait les 24
 * valeurs (12 quantités + 12 magasins) et titrait chaque bande dans le SVG :
 * titres par-dessus les courbes, nombres des extrémités coupés par le bord,
 * étiquettes des magasins collées au trait. Illisible. D'où :
 *  - les titres sortent du dessin (HTML au-dessus, plus aucun recouvrement) ;
 *  - la bande des magasins ne porte plus que sa dernière valeur, son niveau se
 *    lisant à la forme et au maximum rappelé dans la légende ;
 *  - les étiquettes des bords sont ancrées vers l'intérieur, jamais tronquées ;
 *  - chaque mois expose une infobulle native avec les valeurs exactes.
 *
 * Lecture : quantités qui montent avec les magasins = élargissement de la
 * diffusion ; quantités qui montent à magasins constants = vraie accélération
 * des ventes ; quantités qui baissent alors que les magasins tiennent = essoufflement.
 */
export function NetworkLineChart({
    labels,
    values,
    color,
    stores,
}: {
    labels: string[];
    values: number[];
    color: string;
    /** Nombre de magasins vendeurs, même longueur et même ordre que `values`. */
    stores?: number[] | null;
}) {
    const avecMagasins = Array.isArray(stores) && stores.length === values.length && stores.length > 0;
    const n = values.length;

    const W = 520;
    const padL = 14, padR = 14;
    const hautQ = 16;                      // marge haute : place aux étiquettes du sommet
    const bandeQ = 116;
    const ecart = avecMagasins ? 12 : 0;
    const bandeM = avecMagasins ? 44 : 0;
    const moisH = 18;
    const H = hautQ + bandeQ + ecart + bandeM + moisH;
    const plotW = W - padL - padR;

    // Les quantités Qlik peuvent être NÉGATIVES (retours supérieurs aux ventes
    // sur un mois) : l'échelle part du minimum réel, sinon le point sortirait
    // du cadre par le bas.
    const minQ = Math.min(0, ...values);
    const maxQ = Math.max(...values, 1);
    const etendueQ = maxQ - minQ || 1;
    const maxM = avecMagasins ? Math.max(...stores!, 1) : 1;

    const x = (i: number) => (n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2);
    const y = (v: number) => hautQ + bandeQ - ((v - minQ) / etendueQ) * bandeQ;
    const yM = (v: number) => hautQ + bandeQ + ecart + bandeM - (v / maxM) * bandeM;
    const zero = y(0);

    /** Aux extrémités, on ancre l'étiquette vers l'intérieur : sinon elle sort du cadre. */
    const ancrage = (i: number): "start" | "middle" | "end" =>
        i === 0 ? "start" : i === n - 1 ? "end" : "middle";

    const linePts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const areaPts = `${padL},${zero.toFixed(1)} ${linePts} ${(padL + plotW).toFixed(1)},${zero.toFixed(1)}`;
    const storesColor = storesColorFor(color);
    const storePts = avecMagasins
        ? stores!.map((v, i) => `${x(i).toFixed(1)},${yM(v).toFixed(1)}`).join(" ")
        : "";
    const fmt = (v: number) => Math.round(v).toLocaleString("fr-FR");

    return (
        <div className="mt-3 w-full overflow-x-auto">
            {/* Titres HORS du dessin : plus rien ne recouvre les courbes. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-1.5">
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                    <span className="inline-block w-3 h-[3px] rounded-full" style={{ background: color }} />
                    Quantités vendues
                    <span className="tabular-nums" style={{ color: "var(--text-muted)" }}>· max {fmt(maxQ)}</span>
                </span>
                {avecMagasins && (
                    <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                        <span
                            className="inline-block w-3 h-0 rounded-full"
                            style={{ borderTop: `3px dashed ${storesColor}` }}
                        />
                        Magasins vendeurs
                        <span className="tabular-nums" style={{ color: "var(--text-muted)" }}>· max {fmt(maxM)}</span>
                    </span>
                )}
            </div>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full"
                style={{ minWidth: 420 }}
                role="img"
                aria-label={avecMagasins ? "Ventes réseau mensuelles et nombre de magasins vendeurs" : "Ventes réseau mensuelles"}
            >
                {/* ─── Bande 1 : quantités ─────────────────────────────── */}
                <line x1={padL} y1={zero} x2={padL + plotW} y2={zero} stroke="var(--border)" strokeWidth={1} />
                {n > 1 && <polygon points={areaPts} fill={color} opacity={0.08} />}
                {n > 1 && <polyline points={linePts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                {values.map((v, i) => (
                    <g key={`qte-${labels[i]}`}>
                        <circle cx={x(i)} cy={y(v)} r={2.6} fill={color} />
                        <text
                            x={x(i)}
                            y={v >= 0 ? y(v) - 6 : y(v) + 12}
                            textAnchor={ancrage(i)}
                            fontSize={8.5}
                            fontWeight={700}
                            fill="var(--text-primary)"
                        >
                            {fmt(v)}
                        </text>
                    </g>
                ))}

                {/* ─── Bande 2 : magasins vendeurs ─────────────────────── */}
                {avecMagasins && (
                    <>
                        <line
                            x1={padL}
                            y1={hautQ + bandeQ + ecart + bandeM}
                            x2={padL + plotW}
                            y2={hautQ + bandeQ + ecart + bandeM}
                            stroke="var(--border)"
                            strokeWidth={1}
                        />
                        {n > 1 && (
                            <polyline
                                points={storePts}
                                fill="none"
                                stroke={storesColor}
                                strokeWidth={1.75}
                                strokeDasharray="4 3"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        )}
                        {stores!.map((v, i) => (
                            // Point évidé : lisible même sans couleur (impression N&B, daltonisme).
                            <circle
                                key={`mag-${labels[i]}`}
                                cx={x(i)}
                                cy={yM(v)}
                                r={2.2}
                                fill="var(--bg-surface)"
                                stroke={storesColor}
                                strokeWidth={1.3}
                            />
                        ))}
                        {/* Seule la dernière valeur est écrite : le reste se lit à la forme. */}
                        <text
                            x={x(n - 1)}
                            y={yM(stores![n - 1]) - 6}
                            textAnchor="end"
                            fontSize={8.5}
                            fontWeight={700}
                            fill={storesColor}
                        >
                            {fmt(stores![n - 1])} mag.
                        </text>
                    </>
                )}

                {/* ─── Axe des mois, commun aux deux bandes ────────────── */}
                {labels.map((lab, i) => (
                    <text key={`mois-${lab}`} x={x(i)} y={H - 5} textAnchor={ancrage(i)} fontSize={8} fill="var(--text-muted)">
                        {fmtMonthShort(lab)}
                    </text>
                ))}

                {/* Zones de survol : valeurs exactes du mois, sans encombrer le dessin. */}
                {labels.map((lab, i) => (
                    <rect
                        key={`survol-${lab}`}
                        x={x(i) - plotW / (2 * Math.max(1, n - 1))}
                        y={0}
                        width={plotW / Math.max(1, n - 1)}
                        height={H - moisH}
                        fill="transparent"
                    >
                        <title>
                            {`${fmtMonthShort(lab)} · ${fmt(values[i])} vendues${avecMagasins ? ` · ${fmt(stores![i])} magasins` : ""}`}
                        </title>
                    </rect>
                ))}
            </svg>
        </div>
    );
}

/**
 * Deux courbes superposées sur le même axe (comparatif local vs réseau).
 * Les valeurs sont normalisées ensemble pour rester comparables visuellement.
 */
export function DualLineChart({
    labels,
    series,
}: {
    labels: string[];
    series: Array<{ name: string; values: number[]; color: string }>;
}) {
    const W = 620, H = 220;
    const padL = 10, padR = 10, padT = 26, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = labels.length;
    const maxV = Math.max(1, ...series.flatMap((s) => s.values));
    const x = (i: number) => (n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2);
    const y = (v: number) => padT + plotH - (v / maxV) * plotH;

    return (
        <div className="w-full overflow-x-auto">
            <div className="flex items-center gap-4 mb-1">
                {series.map((s) => (
                    <span key={s.name} className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                        <span className="inline-block w-3 h-[3px] rounded-full" style={{ background: s.color }} />
                        {s.name}
                    </span>
                ))}
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 460 }} role="img" aria-label="Comparatif mensuel local vs réseau">
                <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke="var(--border)" strokeWidth={1} />
                {series.map((s) => {
                    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
                    return (
                        <g key={s.name}>
                            {n > 1 && (
                                <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                            )}
                            {s.values.map((v, i) => (
                                <circle key={`${s.name}-${labels[i]}`} cx={x(i)} cy={y(v)} r={2.4} fill={s.color} />
                            ))}
                        </g>
                    );
                })}
                {labels.map((lab, i) => (
                    <text key={lab} x={x(i)} y={H - 10} textAnchor="middle" fontSize={8} fill="var(--text-muted)">
                        {fmtMonthShort(lab)}
                    </text>
                ))}
            </svg>
        </div>
    );
}
