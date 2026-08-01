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

/** Courbe des quantités vendues (contexte) — bleu ciel. */
export const QTY_COLOR = "#0ea5e9";
/** Courbe des magasins vendeurs (contexte) — violet. */
export const STORES_COLOR = "#8b5cf6";

/** Une bande du graphique : une série, son échelle, son style. */
interface Bande {
    titre: string;
    valeurs: number[];
    couleur: string;
    hauteur: number;
    /** Aire douce sous la courbe (réservée à la bande principale). */
    aire?: boolean;
    /** Trait pointillé + points évidés (séries de contexte). */
    pointille?: boolean;
    /** Toutes les valeurs écrites, ou seulement la dernière. */
    etiquettes: "toutes" | "derniere";
    /** Décimales des étiquettes (la qté/magasin est souvent < 10). */
    decimales?: number;
    /** Suffixe de la dernière étiquette (« mag. »). */
    suffixe?: string;
}

/**
 * Ventes réseau mensuelles : jusqu'à trois bandes empilées sur le même axe.
 *
 * ⚠️ LA BANDE PRINCIPALE EST LA QUANTITÉ PAR MAGASIN, pas la quantité brute.
 * La quantité brute confond la performance du produit et sa diffusion : elle
 * monte dès qu'on référence le produit ailleurs, sans qu'il se vende mieux nulle
 * part. C'est `qté / magasins vendeurs` qui dit si un produit marche ; les deux
 * autres bandes sont là pour expliquer ses mouvements, pas pour les juger.
 *
 * ⚠️ DES BANDES, PAS DES COURBES SUPERPOSÉES. Deux échelles superposées
 * plaçaient la courbe des magasins au-dessus de celle des quantités, ce qui se
 * lit comme « il y a plus de magasins que de ventes » — un contresens. Chaque
 * série a sa bande, alignée sur le même axe des mois : on compare des formes,
 * jamais des hauteurs.
 *
 * ⚠️ LA DENSITÉ EST L'ENNEMI. Une version imprimait les 24 valeurs et titrait
 * chaque bande dans le SVG : titres par-dessus les courbes, nombres des bords
 * tronqués, étiquettes collées au trait. D'où les titres en HTML au-dessus du
 * dessin, les étiquettes de bord ancrées vers l'intérieur, les bandes de
 * contexte réduites à leur dernière valeur, et une infobulle par mois qui donne
 * les chiffres exacts sans rien encombrer.
 */
export function NetworkLineChart({
    labels,
    values,
    color,
    stores,
    perStore,
}: {
    labels: string[];
    values: number[];
    color: string;
    /** Nombre de magasins vendeurs, même longueur et même ordre que `values`. */
    stores?: number[] | null;
    /** Quantité par magasin vendeur — la vraie tendance, en bande principale. */
    perStore?: number[] | null;
}) {
    const n = values.length;
    const memeTaille = (s?: number[] | null) => Array.isArray(s) && s.length === n && n > 0;
    const avecParMag = memeTaille(perStore);
    const avecMagasins = memeTaille(stores);

    const fmt = (v: number, d = 0) =>
        v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

    // La bande principale porte la couleur de la tendance ; les bandes de
    // contexte ont des couleurs fixes, pour que la teinte « tendance » ne
    // désigne jamais qu'une seule chose dans le graphique.
    const bandes: Bande[] = avecParMag
        ? [
            { titre: "Qté / magasin", valeurs: perStore!, couleur: color, hauteur: 96, aire: true, etiquettes: "toutes", decimales: perStore!.some((v) => v > 0 && v < 10) ? 1 : 0 },
            { titre: "Quantités vendues", valeurs: values, couleur: QTY_COLOR, hauteur: 74, etiquettes: "toutes" },
        ]
        : [
            { titre: "Quantités vendues", valeurs: values, couleur: color, hauteur: 116, aire: true, etiquettes: "toutes" },
        ];
    if (avecMagasins) {
        bandes.push({ titre: "Magasins vendeurs", valeurs: stores!, couleur: STORES_COLOR, hauteur: 42, pointille: true, etiquettes: "derniere", suffixe: " mag." });
    }

    const W = 520;
    const padL = 14, padR = 14, moisH = 18, hautPremiere = 16, ecart = 15;
    const plotW = W - padL - padR;
    const H = hautPremiere + bandes.reduce((t, b) => t + b.hauteur, 0) + ecart * (bandes.length - 1) + moisH;

    const x = (i: number) => (n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2);
    /** Aux extrémités on ancre vers l'intérieur : sinon l'étiquette sort du cadre. */
    const ancrage = (i: number): "start" | "middle" | "end" =>
        i === 0 ? "start" : i === n - 1 ? "end" : "middle";

    // Position verticale de chaque bande, empilée de haut en bas.
    let curseur = hautPremiere;
    const disposees = bandes.map((b) => {
        const haut = curseur;
        curseur += b.hauteur + ecart;
        // Les quantités Qlik peuvent être NÉGATIVES (retours > ventes sur un
        // mois) : l'échelle part du minimum réel, sinon le point sort du cadre.
        const min = Math.min(0, ...b.valeurs);
        const max = Math.max(...b.valeurs, min + 1);
        const etendue = max - min || 1;
        const y = (v: number) => haut + b.hauteur - ((v - min) / etendue) * b.hauteur;
        return { ...b, haut, max, y };
    });

    return (
        <div className="mt-3 w-full overflow-x-auto">
            {/* Titres HORS du dessin : plus aucun recouvrement possible. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-1.5">
                {disposees.map((b) => (
                    <span key={b.titre} className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                        <span
                            className="inline-block w-3"
                            style={b.pointille
                                ? { borderTop: `3px dashed ${b.couleur}` }
                                : { height: 3, borderRadius: 9999, background: b.couleur }}
                        />
                        {b.titre}
                        <span className="tabular-nums" style={{ color: "var(--text-muted)" }}>· max {fmt(b.max, b.decimales ?? 0)}</span>
                    </span>
                ))}
            </div>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full"
                style={{ minWidth: 420 }}
                role="img"
                aria-label={"Ventes réseau mensuelles : " + disposees.map((b) => b.titre).join(", ")}
            >
                {disposees.map((b) => {
                    const pts = b.valeurs.map((v, i) => `${x(i).toFixed(1)},${b.y(v).toFixed(1)}`).join(" ");
                    const base = b.y(Math.min(0, ...b.valeurs));
                    return (
                        <g key={b.titre}>
                            <line x1={padL} y1={base} x2={padL + plotW} y2={base} stroke="var(--border)" strokeWidth={1} />
                            {b.aire && n > 1 && (
                                <polygon
                                    points={`${padL},${base.toFixed(1)} ${pts} ${(padL + plotW).toFixed(1)},${base.toFixed(1)}`}
                                    fill={b.couleur}
                                    opacity={0.08}
                                />
                            )}
                            {n > 1 && (
                                <polyline
                                    points={pts}
                                    fill="none"
                                    stroke={b.couleur}
                                    strokeWidth={b.pointille ? 1.75 : 2}
                                    strokeDasharray={b.pointille ? "4 3" : undefined}
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                />
                            )}
                            {b.valeurs.map((v, i) => (
                                <circle
                                    key={`${b.titre}-${labels[i]}`}
                                    cx={x(i)}
                                    cy={b.y(v)}
                                    r={b.pointille ? 2.2 : 2.6}
                                    // Points évidés sur les séries de contexte : elles restent
                                    // distinctes même en noir et blanc.
                                    fill={b.pointille ? "var(--bg-surface)" : b.couleur}
                                    stroke={b.pointille ? b.couleur : undefined}
                                    strokeWidth={b.pointille ? 1.3 : undefined}
                                />
                            ))}
                            {b.valeurs.map((v, i) => {
                                if (b.etiquettes === "derniere" && i !== n - 1) return null;
                                return (
                                    <text
                                        key={`lab-${b.titre}-${labels[i]}`}
                                        x={x(i)}
                                        y={v >= 0 ? b.y(v) - 6 : b.y(v) + 12}
                                        textAnchor={ancrage(i)}
                                        fontSize={8.5}
                                        fontWeight={700}
                                        fill={b.etiquettes === "derniere" ? b.couleur : "var(--text-primary)"}
                                    >
                                        {fmt(v, b.decimales ?? 0)}{i === n - 1 ? b.suffixe ?? "" : ""}
                                    </text>
                                );
                            })}
                        </g>
                    );
                })}

                {/* Axe des mois, commun à toutes les bandes */}
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
                            {`${fmtMonthShort(lab)} · ` +
                                disposees.map((b) => `${b.titre} ${fmt(b.valeurs[i], b.decimales ?? 0)}`).join(" · ")}
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
