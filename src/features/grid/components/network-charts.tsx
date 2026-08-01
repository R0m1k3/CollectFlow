"use client";

/**
 * CollectFlow — Graphiques réseau (SVG fait main, aucune librairie de charts).
 *
 * Extraits de `heatmap-grid.tsx` pour être partagés entre la Grille et la fiche
 * produit (`/produits`). Aucun changement de comportement.
 */

import { useState } from "react";
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

/**
 * Couleurs des séries : slots 1-3 de la palette catégorielle validée, exposés en
 * variables CSS pour que le mode sombre soit un jeu de pas CHOISI et vérifié, et
 * non un éclaircissement automatique (cf. `globals.css`).
 */
const SERIE_COULEURS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)"] as const;

/** Une facette du graphique : une série, son échelle, son titre. */
interface Facette {
    titre: string;
    valeurs: number[];
    couleur: string;
    hauteur: number;
    /** Lavis sous la courbe : réservé à la facette principale. */
    aire?: boolean;
    decimales?: number;
    unite?: string;
}

/**
 * Ventes réseau mensuelles — petits multiples empilés sur un axe des mois commun.
 *
 * ⚠️ PAS DE DOUBLE AXE. Superposer qté/magasin, volumes et magasins sur un même
 * cadre demanderait deux ou trois échelles verticales : l'alignement entre elles
 * serait arbitraire et inventerait des corrélations absentes des données. C'est
 * l'erreur de graphique la plus commune. Trois mesures d'ordres de grandeur
 * différents ⇒ trois facettes, une échelle chacune, le même axe horizontal.
 *
 * ⚠️ LA FACETTE PRINCIPALE EST LA QUANTITÉ PAR MAGASIN. La quantité brute confond
 * la performance du produit et sa diffusion : elle monte dès qu'on référence le
 * produit ailleurs, sans qu'il se vende mieux nulle part. Les deux autres
 * facettes expliquent les mouvements de la première, elles ne les jugent pas.
 *
 * ⚠️ ÉTIQUETAGE SÉLECTIF. Une valeur à côté de chaque point, c'est 36 nombres :
 * illisible, et personne ne les lit. Seuls l'extrême et le dernier mois sont
 * écrits ; le survol donne le mois exact et la vue tableau porte tout le reste,
 * de sorte qu'aucune valeur n'est accessible uniquement au survol.
 *
 * Le texte ne porte jamais la couleur d'une série (une teinte claire est
 * illisible en texte) : l'identité vient du repère coloré posé à côté.
 */
export function NetworkLineChart({
    labels,
    values,
    stores,
    perStore,
}: {
    labels: string[];
    values: number[];
    /** Couleur héritée de la tendance : conservée pour l'API, plus utilisée ici —
     *  la teinte « tendance » reste au badge d'en-tête, les séries ont la leur. */
    color?: string;
    stores?: number[] | null;
    perStore?: number[] | null;
}) {
    const [survol, setSurvol] = useState<number | null>(null);
    const [vue, setVue] = useState<"graphique" | "tableau">("graphique");
    const n = values.length;
    const memeTaille = (s?: number[] | null) => Array.isArray(s) && s.length === n && n > 0;
    const avecParMag = memeTaille(perStore);
    const avecMagasins = memeTaille(stores);

    const fmt = (v: number, d = 0) =>
        v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

    const facettes: Facette[] = [];
    if (avecParMag) {
        facettes.push({
            titre: "Qté / magasin",
            valeurs: perStore!,
            couleur: SERIE_COULEURS[0],
            hauteur: 92,
            aire: true,
            decimales: perStore!.some((v) => v > 0 && v < 10) ? 1 : 0,
        });
        facettes.push({ titre: "Quantités vendues", valeurs: values, couleur: SERIE_COULEURS[1], hauteur: 58 });
    } else {
        facettes.push({ titre: "Quantités vendues", valeurs: values, couleur: SERIE_COULEURS[0], hauteur: 110, aire: true });
    }
    if (avecMagasins) {
        facettes.push({ titre: "Magasins vendeurs", valeurs: stores!, couleur: SERIE_COULEURS[2], hauteur: 46 });
    }

    const W = 520;
    const padL = 16, padR = 16, axeH = 18, enteteH = 15, ecart = 12;
    const plotW = W - padL - padR;
    const H = facettes.reduce((t, f) => t + enteteH + f.hauteur + ecart, 0) - ecart + axeH;

    const x = (i: number) => (n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2);
    /** Aux extrémités, l'étiquette est ancrée vers l'intérieur : sinon elle sort du cadre. */
    const ancrage = (i: number): "start" | "middle" | "end" =>
        i === 0 ? "start" : i === n - 1 ? "end" : "middle";

    let curseur = 0;
    const disposees = facettes.map((f) => {
        const hautEntete = curseur;
        const haut = curseur + enteteH;
        curseur = haut + f.hauteur + ecart;
        // Les quantités Qlik peuvent être NÉGATIVES (retours > ventes sur un mois) :
        // l'échelle part du minimum réel, sinon le point sort du cadre par le bas.
        const min = Math.min(0, ...f.valeurs);
        const max = Math.max(...f.valeurs, min + 1);
        const etendue = max - min || 1;
        const y = (v: number) => haut + f.hauteur - ((v - min) / etendue) * f.hauteur;
        const iMax = f.valeurs.indexOf(Math.max(...f.valeurs));
        return { ...f, hautEntete, haut, base: y(min), max, y, iMax };
    });
    const basPlots = curseur - ecart;

    return (
        <div className="mt-3 w-full">
            {/* Bascule : la même surface sert au dessin ou aux chiffres. */}
            <div className="flex justify-end mb-1.5">
                <div className="inline-flex rounded-lg p-0.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                    {(["graphique", "tableau"] as const).map((v) => (
                        <button
                            key={v}
                            type="button"
                            onClick={() => setVue(v)}
                            className="px-2.5 py-0.5 text-[10px] font-semibold rounded-md transition-colors capitalize"
                            style={vue === v
                                ? { background: "var(--bg-surface)", color: "var(--text-primary)" }
                                : { color: "var(--text-muted)" }}
                            aria-pressed={vue === v}
                        >
                            {v}
                        </button>
                    ))}
                </div>
            </div>
            {vue === "graphique" ? (
            <div className="overflow-x-auto">
            <svg
                viewBox={`0 0 ${W} ${H}`}
                width="100%"
                height={H}
                preserveAspectRatio="xMidYMid meet"
                // `display:block` : un SVG en ligne traîne l'espace sous la ligne de
                // base (6 px mesurés), et la carte changeait de hauteur en basculant
                // vers le tableau.
                style={{ minWidth: 460, display: "block" }}
                role="img"
                aria-label={"Ventes réseau mensuelles : " + disposees.map((f) => f.titre).join(", ")}
                onMouseLeave={() => setSurvol(null)}
            >
                {disposees.map((f) => {
                    const pts = f.valeurs.map((v, i) => `${x(i).toFixed(1)},${f.y(v).toFixed(1)}`).join(" ");
                    // L'extrême et le dernier mois seulement : deux repères qui
                    // situent la courbe, sans noyer le dessin sous les nombres.
                    const aEtiqueter = [...new Set([f.iMax, n - 1])];
                    return (
                        <g key={f.titre}>
                            {/* Bandeau de facette : repère coloré + titre + maximum, en encre neutre */}
                            <rect x={padL} y={f.hautEntete + 3} width={12} height={3} rx={1.5} fill={f.couleur} />
                            <text x={padL + 18} y={f.hautEntete + 7} fontSize={9.5} fontWeight={600} fill="var(--text-secondary)" dominantBaseline="middle">
                                {f.titre}
                            </text>
                            <text x={padL + plotW} y={f.hautEntete + 7} textAnchor="end" fontSize={9} fill="var(--text-muted)" dominantBaseline="middle">
                                max {fmt(f.max, f.decimales ?? 0)}{f.unite ?? ""}
                            </text>

                            {/* Ligne de base : filet plein, une nuance au-dessus du fond */}
                            <line x1={padL} y1={f.base} x2={padL + plotW} y2={f.base} stroke="var(--border)" strokeWidth={1} />
                            {f.aire && n > 1 && (
                                <polygon
                                    points={`${padL},${f.base.toFixed(1)} ${pts} ${(padL + plotW).toFixed(1)},${f.base.toFixed(1)}`}
                                    fill={f.couleur}
                                    opacity={0.1}
                                />
                            )}
                            {n > 1 && (
                                <polyline points={pts} fill="none" stroke={f.couleur} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                            )}

                            {/* Points repères : extrême et dernier mois, cerclés de la couleur du fond */}
                            {aEtiqueter.map((i) => (
                                <circle
                                    key={`pt-${f.titre}-${i}`}
                                    cx={x(i)}
                                    cy={f.y(f.valeurs[i])}
                                    r={4}
                                    fill={f.couleur}
                                    stroke="var(--bg-surface)"
                                    strokeWidth={2}
                                />
                            ))}
                            {aEtiqueter.map((i) => {
                                // Un point proche du sommet verrait son étiquette empiéter sur le
                                // bandeau de la facette (constaté au rendu : « 58 » par-dessus
                                // « Qté / magasin »). Dans ce cas elle bascule SOUS le point.
                                const yPoint = f.y(f.valeurs[i]);
                                const dessus = yPoint - 8 >= f.haut + 8;
                                return (
                                    <text
                                        key={`lab-${f.titre}-${i}`}
                                        x={x(i)}
                                        y={dessus ? yPoint - 8 : yPoint + 13}
                                        textAnchor={ancrage(i)}
                                        fontSize={9}
                                        fontWeight={700}
                                        fill="var(--text-primary)"
                                    >
                                        {fmt(f.valeurs[i], f.decimales ?? 0)}
                                    </text>
                                );
                            })}

                            {/* Point mis en avant au survol */}
                            {survol != null && (
                                <circle
                                    cx={x(survol)}
                                    cy={f.y(f.valeurs[survol])}
                                    r={3.5}
                                    fill={f.couleur}
                                    stroke="var(--bg-surface)"
                                    strokeWidth={2}
                                />
                            )}
                        </g>
                    );
                })}

                {/* Réticule : un seul trait vertical relie les trois facettes au même mois */}
                {survol != null && (
                    <line x1={x(survol)} y1={0} x2={x(survol)} y2={basPlots} stroke="var(--border-strong)" strokeWidth={1} />
                )}

                {/* Axe des mois, commun aux facettes */}
                {labels.map((lab, i) => (
                    <text
                        key={`mois-${lab}`}
                        x={x(i)}
                        y={H - 5}
                        textAnchor={ancrage(i)}
                        fontSize={8.5}
                        fill={survol === i ? "var(--text-primary)" : "var(--text-muted)"}
                        fontWeight={survol === i ? 700 : 400}
                    >
                        {fmtMonthShort(lab)}
                    </text>
                ))}

                {/* Infobulle DANS le dessin.
                    Elle vivait sous le SVG, en HTML : selon la longueur des valeurs elle
                    passait sur deux lignes et la carte changeait de hauteur en cours de
                    survol. Ici la géométrie est figée par le viewBox — la carte ne bouge
                    plus jamais. `pointerEvents=none` laisse passer le survol vers les
                    cibles en dessous. */}
                {survol != null && (() => {
                    const largeur = 158;
                    const hauteur = 16 + disposees.length * 13 + 8;
                    // La bulle bascule à gauche du réticule quand elle déborderait à droite.
                    const gauche = x(survol) + 10 + largeur > W - 4;
                    const bx = gauche ? x(survol) - 10 - largeur : x(survol) + 10;
                    return (
                        <g pointerEvents="none">
                            <rect
                                x={bx} y={4} width={largeur} height={hauteur} rx={8}
                                fill="var(--bg-elevated)" stroke="var(--border)" strokeWidth={1}
                            />
                            <text x={bx + 9} y={17} fontSize={9.5} fontWeight={700} fill="var(--text-primary)">
                                {fmtMonthShort(labels[survol])}
                            </text>
                            {disposees.map((f, k) => (
                                <g key={`bulle-${f.titre}`}>
                                    <rect x={bx + 9} y={26 + k * 13} width={8} height={3} rx={1.5} fill={f.couleur} />
                                    <text x={bx + 22} y={30 + k * 13} fontSize={9} fill="var(--text-secondary)">
                                        {f.titre}
                                    </text>
                                    <text
                                        x={bx + largeur - 9} y={30 + k * 13}
                                        textAnchor="end" fontSize={9} fontWeight={700} fill="var(--text-primary)"
                                    >
                                        {fmt(f.valeurs[survol], f.decimales ?? 0)}
                                    </text>
                                </g>
                            ))}
                        </g>
                    );
                })()}

                {/* Zones de survol : larges cibles, une par mois */}
                {labels.map((lab, i) => (
                    <rect
                        key={`survol-${lab}`}
                        x={x(i) - plotW / (2 * Math.max(1, n - 1))}
                        y={0}
                        width={plotW / Math.max(1, n - 1)}
                        height={H}
                        fill="transparent"
                        onMouseEnter={() => setSurvol(i)}
                    />
                ))}
            </svg>
            </div>
            ) : (
            /* Vue tableau : même panneau, MÊME HAUTEUR.
                Un dépliant aurait fait grandir la carte à l'ouverture — exactement ce
                qu'on venait de corriger sur le survol. Le tableau occupe donc la place
                du graphique et défile à l'intérieur : la carte garde sa taille, et
                aucune valeur n'est réservée au survol. */
            <div style={{ height: H }} className="overflow-y-auto overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums" style={{ borderCollapse: "collapse" }}>
                    <thead className="sticky top-0" style={{ background: "var(--bg-surface)" }}>
                        <tr style={{ color: "var(--text-muted)" }}>
                            <th className="text-left font-medium py-1 pr-2">Mois</th>
                            {disposees.map((f) => (
                                <th key={`th-${f.titre}`} className="text-right font-medium py-1 pl-2 whitespace-nowrap">
                                    {f.titre}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {labels.map((lab, i) => (
                            <tr key={`tr-${lab}`} style={{ borderTop: "1px solid var(--border)" }}>
                                <td className="py-1 pr-2 whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                    {fmtMonthShort(lab)}
                                </td>
                                {disposees.map((f) => (
                                    <td key={`td-${f.titre}-${lab}`} className="text-right py-1 pl-2" style={{ color: "var(--text-primary)" }}>
                                        {fmt(f.valeurs[i], f.decimales ?? 0)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            )}
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
