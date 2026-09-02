"use client";

/**
 * CollectFlow — Détail mensuel d'un produit, ouvert depuis la case « Tot. 12m ».
 *
 * La colonne de total dit COMBIEN, jamais COMMENT. On empile donc les trois
 * séries qui expliquent le total, dans l'ordre où on les lit : ce qui est sorti
 * (ventes), ce qui est entré (réceptions), puis ce qui reste — magasin par
 * magasin, parce qu'un stock de 40 réparti sur deux sites et un stock de 40
 * bloqué sur un seul ne se pilotent pas pareil.
 *
 * SVG fait main comme le reste des graphiques du dossier : aucune librairie.
 */

import React from "react";
import { ShoppingCart, PackageOpen, Warehouse } from "lucide-react";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TuileStat } from "@/features/grid/components/stat-tile";
import { formatMonthLabel, formatDate, SITE_LABELS } from "@/features/grid/lib/months";
import type { ProductRow } from "@/types/grid";

/** Couleurs de séries : slots de la palette catégorielle validée (cf. `globals.css`). */
const COULEUR_VENTES = "var(--viz-1)";
const COULEUR_ENTREES = "var(--viz-3)";

const fmt = (v: number) => Math.round(v).toLocaleString("fr-FR");

/**
 * Barres mensuelles sur une ligne de zéro explicite.
 *
 * Les quantités peuvent être NÉGATIVES (retours supérieurs aux ventes sur un
 * mois) : l'échelle part donc du minimum réel et les barres se dessinent de part
 * et d'autre du zéro, sinon un mois de retours sortirait du cadre par le bas.
 *
 * Chaque barre porte sa valeur écrite : douze nombres restent lisibles à cette
 * largeur, et aucune valeur n'est ainsi accessible au seul survol.
 */
function BarresMensuelles({ mois, valeurs, couleur, aria }: {
    mois: string[];
    valeurs: number[];
    couleur: string;
    aria: string;
}) {
    const n = valeurs.length;
    const min = Math.min(0, ...valeurs);
    const max = Math.max(0, ...valeurs);

    // Une barre négative écrit sa valeur SOUS elle : sans marge basse
    // supplémentaire, ce nombre se poserait sur les libellés de mois.
    const W = 660, hautPlot = 104, padH = 18;
    const padB = min < 0 ? 42 : 24;
    const H = padH + hautPlot + padB;

    const etendue = max - min || 1;
    const y = (v: number) => padH + hautPlot - ((v - min) / etendue) * hautPlot;
    const yZero = y(0);

    const pas = W / n;
    const largeur = Math.min(pas * 0.6, 34);

    return (
        <div className="overflow-x-auto min-w-0">
        <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            preserveAspectRatio="xMidYMid meet"
            // `display:block` : un SVG en ligne traîne l'espace sous la ligne de
            // base et décale la section suivante.
            style={{ minWidth: 520, display: "block" }}
            role="img"
            aria-label={aria}
        >
            <line x1={0} y1={yZero} x2={W} y2={yZero} stroke="var(--border)" strokeWidth={1} />
            {valeurs.map((v, i) => {
                const cx = pas * i + pas / 2;
                const yVal = y(v);
                const haut = Math.min(yVal, yZero);
                const hauteur = Math.max(Math.abs(yVal - yZero), 1.5);
                return (
                    <g key={mois[i]}>
                        {v !== 0 && (
                            <rect
                                x={cx - largeur / 2}
                                y={haut}
                                width={largeur}
                                height={hauteur}
                                rx={2.5}
                                fill={couleur}
                                opacity={0.9}
                            />
                        )}
                        <text
                            x={cx}
                            y={v < 0 ? yZero + hauteur + 12 : haut - 5}
                            textAnchor="middle"
                            fontSize={11.5}
                            fontWeight={700}
                            fill={v === 0 ? "var(--text-muted)" : "var(--text-secondary)"}
                        >
                            {fmt(v)}
                        </text>
                        <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
                            {formatMonthLabel(mois[i])}
                        </text>
                    </g>
                );
            })}
        </svg>
        </div>
    );
}

/** En-tête de section : repère coloré + titre + cumul de la série. */
function EnteteSection({ icone: Icone, titre, detail, couleur }: {
    icone: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
    titre: string;
    detail: string;
    couleur: string;
}) {
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded-sm shrink-0" style={{ width: 14, height: 4, background: couleur }} />
            <Icone className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
            <h3 className="text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>{titre}</h3>
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{detail}</span>
        </div>
    );
}

/**
 * Une série mensuelle ventilée par magasin, un magasin par ligne.
 *
 * Sert aux ventes (flux : une colonne « 12 m » cumule la ligne) comme au stock
 * (niveau : additionner douze fins de mois n'aurait aucun sens, pas de cumul).
 *
 * La ligne de total est recalculée depuis les lignes affichées : un total qui ne
 * correspond pas à la somme visible fait douter du tableau entier.
 */
function TableauParMagasin({ row, mois, activeMagasin, parSite, agrege, sousLigne, cumul, aria }: {
    row: ProductRow;
    mois: string[];
    activeMagasin: string;
    /** Série par magasin (site → mois → valeur). */
    parSite: Record<string, Record<string, number>> | undefined;
    /** Série agrégée réseau, affichée seule quand aucune ventilation n'existe. */
    agrege: Record<string, number>;
    /** Texte secondaire sous le nom du magasin (`null` pour la ligne réseau). */
    sousLigne: (site: string | null, valeurs: number[]) => string;
    /** Ajoute une colonne de cumul sur 12 mois (flux uniquement). */
    cumul?: boolean;
    aria: string;
}) {
    const sites = [...new Set([
        ...Object.keys(row.stock12mByStore ?? {}),
        ...Object.keys(row.sales12mByStore ?? {}),
    ])].sort();

    // Sans ventilation par site (produit jamais mouvementé, données partielles),
    // on montre au moins la série agrégée plutôt qu'un tableau vide.
    const lignes = sites.length > 0
        ? sites.map((site) => {
            const valeurs = mois.map((m) => parSite?.[site]?.[m] ?? 0);
            return { cle: site, nom: SITE_LABELS[site]?.nom ?? site, actif: activeMagasin === site, valeurs, sous: sousLigne(site, valeurs) };
        })
        : [(() => {
            const valeurs = mois.map((m) => agrege[m] ?? 0);
            return { cle: "TOTAL", nom: "Total réseau", actif: true, valeurs, sous: sousLigne(null, valeurs) };
        })()];

    const totaux = mois.map((_, i) => lignes.reduce((t, l) => t + l.valeurs[i], 0));
    const somme = (v: number[]) => v.reduce((t, x) => t + x, 0);

    const cellule = (v: number, key: string, gras = false) => (
        <td
            key={key}
            className={`px-1.5 py-1.5 text-right tabular-nums${gras ? " font-bold" : ""}`}
            style={{ color: v === 0 && !gras ? "var(--text-muted)" : "var(--text-primary)" }}
        >
            {fmt(v)}
        </td>
    );

    return (
        <div className="rounded-xl overflow-x-auto min-w-0" style={{ border: "1px solid var(--border)" }}>
            <table className="w-full text-[11.5px]" style={{ minWidth: 600 }} aria-label={aria}>
                <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                        <th className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>
                            Magasin
                        </th>
                        {mois.map((m) => (
                            <th key={m} className="text-right px-1.5 py-1.5 font-semibold whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                                {formatMonthLabel(m)}
                            </th>
                        ))}
                        {cumul && (
                            <th className="text-right px-2 py-1.5 font-bold whitespace-nowrap" style={{ color: "var(--text-primary)", borderLeft: "1px solid var(--border)" }}>
                                12 m
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {lignes.map((l) => {
                        const surligne = l.actif && activeMagasin !== "TOTAL";
                        return (
                            <tr key={l.cle} style={{ borderTop: "1px solid var(--border)", background: surligne ? "var(--accent-bg)" : undefined }}>
                                <td className="px-2.5 py-1.5 whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
                                    <div className="font-semibold">{l.nom}</div>
                                    {/* L'information secondaire (dernière entrée, mois avec
                                        vente) est écrite, pas réservée au survol. */}
                                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{l.sous}</div>
                                </td>
                                {l.valeurs.map((v, i) => cellule(v, mois[i]))}
                                {cumul && (
                                    <td className="px-2 py-1.5 text-right tabular-nums font-bold" style={{ color: "var(--text-primary)", borderLeft: "1px solid var(--border)" }}>
                                        {fmt(somme(l.valeurs))}
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                    {lignes.length > 1 && (
                        <tr style={{ borderTop: "1px solid var(--border-strong)", background: "var(--bg-elevated)" }}>
                            <td className="px-2.5 py-1.5 font-bold" style={{ color: "var(--text-primary)" }}>
                                Total
                            </td>
                            {totaux.map((v, i) => cellule(v, mois[i], true))}
                            {cumul && (
                                <td className="px-2 py-1.5 text-right tabular-nums font-bold" style={{ color: "var(--text-primary)", borderLeft: "1px solid var(--border)" }}>
                                    {fmt(somme(totaux))}
                                </td>
                            )}
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

/**
 * Détail 12 mois d'un produit : ventes, entrées en stock, stock par magasin.
 *
 * Les graphiques suivent le magasin actif de la Grille (cohérence avec la case
 * cliquée) ; les tableaux de ventes et de stock restent toujours ventilés par
 * magasin, c'est leur objet.
 *
 * `mois` est la fenêtre du serveur (lue dans les données, cf. `months.ts`) :
 * c'est ce qui garantit que la tuile « Ventes 12 m » retombe sur le total de la
 * Grille.
 */
export function ProductMonthlyModal({ row, mois, activeMagasin, onClose }: {
    row: ProductRow;
    mois: string[];
    activeMagasin: string;
    onClose: () => void;
}) {
    const surTotal = activeMagasin === "TOTAL";
    const libelleMagasin = surTotal ? "Tous magasins" : (SITE_LABELS[activeMagasin]?.nom ?? activeMagasin);

    const ventes = mois.map((m) => (surTotal
        ? row.sales12m[m]
        : row.sales12mByStore?.[activeMagasin]?.[m]) ?? 0);
    const entrees = mois.map((m) => (surTotal
        ? row.receptions12m[m]
        : row.receptions12mByStore?.[activeMagasin]?.[m]) ?? 0);
    const stocks = mois.map((m) => (surTotal
        ? row.stock12m[m]
        : row.stock12mByStore?.[activeMagasin]?.[m]) ?? 0);

    // Sur un magasin donné, la dernière entrée du réseau n'est pas la sienne.
    const derniereEntree = surTotal
        ? row.derniereLivraison
        : row.derniereLivraisonByStore?.[activeMagasin];

    const totalVentes = ventes.reduce((t, v) => t + v, 0);
    const totalEntrees = entrees.reduce((t, v) => t + v, 0);
    const stockFin = stocks[stocks.length - 1] ?? 0;
    const moisAvecVente = ventes.filter((v) => v !== 0).length;

    // Couverture : combien de mois le stock actuel tient-il au rythme des 12
    // derniers mois ? Sans vente, le ratio n'existe pas — on ne l'invente pas.
    const rythme = totalVentes / mois.length;
    const couverture = rythme > 0 ? stockFin / rythme : null;

    return (
        <DialogContent
            // `grid-cols-1` : sans colonne explicite, la grille de la modale se
            // dimensionne sur son contenu le plus large (le tableau des magasins)
            // et déborde par la droite au lieu de le laisser défiler.
            className="max-w-[calc(100%-2rem)] sm:max-w-4xl grid-cols-1 max-h-[88vh] overflow-y-auto"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            onInteractOutside={onClose}
        >
            <DialogHeader>
                <DialogTitle className="text-lg leading-snug pr-6" style={{ color: "var(--text-primary)" }}>
                    {row.libelle1}
                </DialogTitle>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                    {row.codein}
                    {row.reference ? ` · ${row.reference}` : ""}
                    {" · "}
                    <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{libelleMagasin}</span>
                    {" · 12 mois glissants, mois en cours exclu"}
                </p>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
                <TuileStat
                    label="Ventes 12 m"
                    valeur={fmt(totalVentes)}
                    indice={`${moisAvecVente} mois avec vente · ${rythme.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} / mois`}
                    icone={ShoppingCart}
                />
                <TuileStat
                    label="Entrées 12 m"
                    valeur={totalEntrees > 0 ? `+${fmt(totalEntrees)}` : "—"}
                    indice={derniereEntree ? `dernière entrée ${formatDate(derniereEntree)}` : "aucune entrée enregistrée"}
                    couleur={totalEntrees > 0 ? COULEUR_ENTREES : undefined}
                    icone={PackageOpen}
                />
                <TuileStat
                    label="Stock fin de période"
                    valeur={fmt(stockFin)}
                    indice={couverture != null
                        ? `≈ ${couverture.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} mois de couverture`
                        : "pas de vente sur la période"}
                    icone={Warehouse}
                />
            </div>

            <section className="space-y-1.5">
                <EnteteSection
                    icone={ShoppingCart}
                    titre="Ventes mensuelles"
                    detail={`${fmt(totalVentes)} unités sur 12 mois`}
                    couleur={COULEUR_VENTES}
                />
                <BarresMensuelles
                    mois={mois}
                    valeurs={ventes}
                    couleur={COULEUR_VENTES}
                    aria={`Ventes mensuelles de ${row.libelle1} sur 12 mois`}
                />
                {/* Le graphique donne la forme, le tableau donne les chiffres par
                    magasin — et son cumul « 12 m » est le même total que la tuile
                    et que la case cliquée dans la Grille. */}
                <TableauParMagasin
                    row={row}
                    mois={mois}
                    activeMagasin={activeMagasin}
                    parSite={row.sales12mByStore}
                    agrege={row.sales12m}
                    sousLigne={(_site, valeurs) => {
                        const n = valeurs.filter((v) => v !== 0).length;
                        return n === 0 ? "aucune vente" : `${n} mois avec vente`;
                    }}
                    cumul
                    aria={`Ventes mensuelles de ${row.libelle1} par magasin`}
                />
            </section>

            <section className="space-y-1">
                <EnteteSection
                    icone={PackageOpen}
                    titre="Entrées en stock"
                    detail={totalEntrees > 0 ? `+${fmt(totalEntrees)} unités reçues sur 12 mois` : "aucune réception sur la période"}
                    couleur={COULEUR_ENTREES}
                />
                <BarresMensuelles
                    mois={mois}
                    valeurs={entrees}
                    couleur={COULEUR_ENTREES}
                    aria={`Entrées en stock de ${row.libelle1} sur 12 mois`}
                />
            </section>

            <section className="space-y-1.5">
                <EnteteSection
                    icone={Warehouse}
                    titre="Stock par magasin"
                    detail="stock de fin de mois"
                    couleur="var(--border-strong)"
                />
                <TableauParMagasin
                    row={row}
                    mois={mois}
                    activeMagasin={activeMagasin}
                    parSite={row.stock12mByStore}
                    agrege={row.stock12m}
                    sousLigne={(site) => {
                        // La date de dernière entrée explique un stock qui ne bouge plus.
                        const d = site ? row.derniereLivraisonByStore?.[site] : row.derniereLivraison;
                        return d ? `dern. entrée ${formatDate(d)}` : "aucune entrée";
                    }}
                    aria={`Stock de fin de mois de ${row.libelle1} par magasin`}
                />
            </section>
        </DialogContent>
    );
}
