"use client";

import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    getFilteredRowModel,
    flexRender,
    ColumnDef,
    SortingState,
    RowSelectionState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronUp, ChevronDown, ChevronsUpDown, Copy, Check, Store, SlidersHorizontal, ShoppingCart, PackageOpen, Warehouse, AlertTriangle, TrendingUp, TrendingDown, Minus, CalendarRange, Tag, Eye, EyeOff } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GammeSelect } from "@/features/grid/components/gamme-select";
import { HeatmapCell } from "@/features/grid/components/heatmap-cell";
import { TuileStat } from "@/features/grid/components/stat-tile";
import { ProductMonthlyModal } from "@/features/grid/components/product-monthly-modal";
import type { ProductRow, GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";
import {
    getLast12Months,
    formatMonthLabel,
    formatDate,
    SITE_LABELS,
    getStoreConfig,
} from "@/features/grid/lib/months";
import {
    computeNetworkTrend,
    computeStoresSeries,
    trendLabel,
    TREND_COLOR,
    NB_MAGASINS_RESEAU,
} from "@/features/grid/lib/network-trend";
import { TrendSparkline, NetworkLineChart } from "@/features/grid/components/network-charts";

interface HeatmapGridProps {
    onSelectionChange?: (codeins: string[]) => void;
    isAdmin?: boolean;
}

const EMPTY_DRAFT_CHANGES: Record<string, GammeCode> = {};

const QLIK_NETWORK_COLUMN_IDS = new Set<string>([
    "caReseau",
    "qteReseau",
    "nbMagasinsReseau",
    "tendanceReseau",
    "prixMoyenReseau",
    "caParMagasinReseau",
    "margePctReseau",
]);

/**
 * Valeur de tri d'une colonne dont la donnée peut manquer : `undefined`, jamais
 * zéro — un article que la source ne renseigne pas n'a pas vendu pour 0 €.
 *
 * Les colonnes qui l'emploient portent `sortUndefined: "last"`, qui garde ces
 * lignes en bas dans LES DEUX SENS. Une sentinelle ±Infinity choisie d'après le
 * sens de tri courant ne le pouvait pas : TanStack mémorise le résultat de
 * l'accesseur dans `row._valuesCache` sans jamais le réévaluer, si bien que la
 * sentinelle calculée au premier tri restait figée et renvoyait les lignes sans
 * donnée en tête dès qu'on inversait le sens.
 */
const valeurTriable = (value: number | null | undefined): number | undefined => value ?? undefined;

/**
 * Prix de vente moyen constaté sur le réseau.
 *
 * Même définition que la fiche produit (`/produits`) : CA réseau ÷ quantité
 * vendue. Sans quantité, le rapport n'existe pas — on rend `null` plutôt que
 * zéro, un prix nul se confondrait avec un article donné.
 */
function prixMoyenReseau(row: ProductRow): number | null {
    const qte = row.qteReseau;
    const ca = row.caReseau;
    if (qte == null || ca == null || qte <= 0) return null;
    return ca / qte;
}

/** Montant en euros au centime — l'usage sur des prix unitaires. */
const fmtEuro2 = (v: number) =>
    v.toLocaleString("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Prix de vente à montrer pour le magasin consulté.
 *
 * `cube_pv` a une clé `(artnoid, site)`, mais notre base n'y met en pratique
 * qu'une ligne par article : le prix n'est pas ventilé par magasin. La colonne
 * doit donc rester lisible dans les deux cas de figure —
 *
 *   · magasin consulté tarifé → SON prix ;
 *   · prix unique, non ventilé → ce prix vaut pour tous les magasins ;
 *   · plusieurs prix mais aucun pour ce magasin → rien, plutôt que celui du
 *     voisin ;
 *   · en « tous magasins » : le prix commun, et s'ils divergent le plus élevé
 *     assorti d'un signal. Une cellule ne peut afficher qu'un nombre, mais
 *     taire l'écart ferait passer le prix d'un magasin pour celui des deux.
 */
function prixVenteAffiche(row: ProductRow, activeMagasin: string): { valeur: number | null; divergent: boolean; detail: string | null } {
    const entrees = Object.entries(row.prixVenteByStore ?? {});

    // Aucun prix ventilé : reste le PV de la fiche article, s'il existe.
    if (entrees.length === 0) return { valeur: row.prixVente ?? null, divergent: false, detail: null };

    // Comparaison au centime : deux flottants issus du même prix peuvent différer
    // dans les décimales lointaines sans que le prix affiché change.
    const distincts = new Set(entrees.map(([, pv]) => Math.round(pv * 100)));

    if (activeMagasin !== "TOTAL") {
        const pv = row.prixVenteByStore?.[activeMagasin];
        if (pv != null) return { valeur: pv, divergent: false, detail: null };
        if (distincts.size === 1) {
            return { valeur: entrees[0][1], divergent: false, detail: "prix unique, non ventilé par magasin" };
        }
        return { valeur: null, divergent: false, detail: null };
    }

    const detail = entrees.length > 1
        ? entrees
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([site, pv]) => `${SITE_LABELS[site]?.nom ?? site} : ${fmtEuro2(pv)}`)
            .join(" · ")
        : null;

    return {
        valeur: Math.max(...entrees.map(([, pv]) => pv)),
        divergent: distincts.size > 1,
        detail,
    };
}

// =========================================================================
// OPTIMISATION PERFORMANCES (React.memo + Zustand Selectors granulaires)
// =========================================================================

// 1. Composant isolé pour la Cellule Gamme (évite le re-render des colonnes)
/**
 * Cellule dont la valeur se copie d'un clic.
 *
 * Extraite de la colonne « Code interne », qui la portait en ligne avec un
 * `eslint-disable react-hooks/rules-of-hooks` : un `useState` dans le corps d'un
 * `cell()` de TanStack n'est pas rendu au même endroit d'un rendu à l'autre. Un
 * vrai composant supprime la dérogation et rend la copie réutilisable — les
 * références et les gencodes se recopient autant que les codes internes.
 *
 * `stopPropagation` est indispensable : sans lui, le clic sélectionne aussi la
 * ligne.
 */
const CopiableCell = React.memo(function CopiableCell({ value, titre, className, style }: {
    value: string | null | undefined;
    titre: string;
    className?: string;
    style?: React.CSSProperties;
}) {
    const [copied, setCopied] = useState(false);
    const texte = (value ?? "").trim();

    if (!texte) {
        return <span className={className} style={style}>-</span>;
    }

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(texte);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            onClick={handleCopy}
            className="group flex items-center gap-1.5 cursor-pointer hover:text-emerald-500 transition-colors min-w-0"
            title={copied ? "Copié !" : titre}
        >
            <span className={cn("truncate", className)} style={style}>{texte}</span>
            <span className="shrink-0 transition-all duration-200">
                {copied ? (
                    <Check className="w-3 h-3 text-emerald-500 animate-in zoom-in-50" />
                ) : (
                    <Copy className="w-3 h-3 opacity-0 group-hover:opacity-40 hover:!opacity-100" />
                )}
            </span>
        </div>
    );
});

const GammeCell = React.memo(({ row, isAdmin }: { row: ProductRow; isAdmin?: boolean }) => {
    // Abonnement ultra-ciblé : la cellule ne re-render que si SA valeur change
    const codein = row.codein;
    const isDraft = useGridStore((s) => s.draftChanges[codein] !== undefined);
    const effectiveGamme = useGridStore((s) => s.draftChanges[codein] ?? row.codeGamme);
    const setDraftGamme = useGridStore((s) => s.setDraftGamme);

    const isModified = row.codeGamme !== row.codeGammeInit && row.codeGammeInit !== null;
    const displayValue = (!effectiveGamme || effectiveGamme.trim() === "") ? "Aucune" : effectiveGamme;

    if (!isAdmin) {
        return (
            <div className={[
                "w-full text-xs font-bold rounded-lg py-1.5 px-2 text-center",
                displayValue === "A" ? "bg-emerald-500/10 text-emerald-700" :
                displayValue === "B" ? "bg-blue-500/10 text-blue-700" :
                displayValue === "C" ? "bg-amber-500/10 text-amber-700" :
                displayValue === "Y" ? "bg-violet-500/10 text-violet-700" :
                displayValue === "Z" ? "bg-rose-500/10 text-rose-700" :
                "bg-slate-500/10 text-slate-500"
            ].join(" ")}>
                {displayValue === "Aucune" ? "—" : displayValue}
            </div>
        );
    }

    return (
        <div className="relative group/gamme">
            <GammeSelect
                value={effectiveGamme as GammeCode | null}
                isDraft={isDraft}
                onChange={(g: GammeCode) => setDraftGamme(codein, g)}
            />
            {isModified && !isDraft && (
                <div className="absolute -right-2 -top-2 bg-emerald-500 text-white rounded-full p-0.5 shadow-sm z-10 animate-in zoom-in-50" title="Modifié et validé">
                    <Check className="w-2.5 h-2.5" />
                </div>
            )}
        </div>
    );
});
GammeCell.displayName = "GammeCell";

import { Cell, Column, Row } from "@tanstack/react-table";
import { VirtualItem } from "@tanstack/react-virtual";

// 2. Composant isolé pour la Ligne Virtuelle 
// (Gère l'état grisé "Z" localement sans faire re-render toute la grid)
interface VirtualRowProps {
    virtualRow: VirtualItem;
    row: Row<ProductRow>;
    rowHeight: number;
    isSelected: boolean;
    /** Identifiants des colonnes visibles, concaténés — cf. le corps du composant. */
    columnsKey: string;
    columnSizing: Record<string, number>;
}

const GridRow = React.memo(({ virtualRow, row, rowHeight, isSelected, columnsKey, columnSizing }: VirtualRowProps) => {
    // Uniquement la ligne concernée écoute son propre changement pour l'effet visuel
    const effectiveGamme = useGridStore((s) => s.draftChanges[row.original.codein] ?? row.original.codeGamme);
    // ⚠️ Ces deux props ne sont pas lues : elles n'existent que pour rompre la
    // mémoïsation. TanStack met ses objets `Row` en cache sur la seule identité
    // des DONNÉES ; changer le jeu de colonnes ne leur donne aucune référence
    // neuve. Sans un signal supplémentaire, `React.memo` laisserait les lignes
    // déjà montées peindre l'ancien jeu de cellules pendant que l'en-tête, lui,
    // affiche le nouveau — seules les lignes fraîchement virtualisées seraient à
    // jour, et la grille se retrouverait à deux vitesses.
    //
    // La signature couvre TOUT changement de colonnes (case décochée dans le menu
    // « Colonnes », bloc mensuel replié) là où l'ancien objet `columnVisibility`
    // ne voyait que le menu.
    void columnsKey;
    void columnSizing; // idem, pour le redimensionnement des colonnes

    return (
        <tr
            data-index={virtualRow.index}
            onClick={() => row.toggleSelected()}
            className={cn(
                "absolute w-full flex items-center cursor-pointer transition-all duration-200 group/row",
                effectiveGamme === "Z" && "opacity-40 grayscale-[0.5] hover:grayscale-0 hover:opacity-100"
            )}
            style={{
                height: `${rowHeight}px`,
                transform: `translateY(${virtualRow.start}px)`,
                borderBottom: "1px solid var(--border)",
                background: isSelected ? "var(--accent-bg)" : "transparent",
                borderLeft: isSelected ? "3px solid var(--accent)" : "3px solid transparent",
            }}
        >
            {row.getVisibleCells().map((cell: Cell<ProductRow, unknown>) => {
                const isFlexible = cell.column.id === "libelle1" || cell.column.id === "libelle3";
                const isCenter = cell.column.id === "totalQuantite" || cell.column.id === "totalCa" || cell.column.id === "totalMarge" || cell.column.id.startsWith("month_") || cell.column.id === "gammeInitial" || QLIK_NETWORK_COLUMN_IDS.has(cell.column.id) || cell.column.id === "prixVente" || cell.column.id === "gamme";
                const size = cell.column.getSize();
                return (
                    <td
                        key={cell.id}
                        className={cn(
                            "px-2 overflow-hidden flex items-center transition-colors group-hover/row:bg-white/5",
                            isSelected && "bg-transparent"
                        )}
                        style={{
                            width: isFlexible ? "100%" : size,
                            flex: isFlexible ? `1 1 ${size}px` : `0 0 ${size}px`,
                            minWidth: size,
                            maxWidth: isFlexible ? "none" : size,
                            height: `${rowHeight}px`,
                            justifyContent: isCenter ? "center" : "flex-start"
                        }}
                    >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                );
            })}
        </tr>
    );
});
GridRow.displayName = "GridRow";

// =========================================================================
// Composant modal pour le détail d'une cellule mensuelle
// =========================================================================

interface CellDetailData {
    row: ProductRow;
    monthKey: string;
    qty: number | null;
    stock: number | null;
    receptions: number | null;
}

/**
 * Carte « tendance réseau » : le verdict en tuiles, puis les trois séries
 * mensuelles en petits multiples.
 *
 * La couleur de tendance (vert / rouge / gris) ne vit QUE dans la tuile de
 * verdict, accompagnée d'une flèche et d'un libellé : un état ne se signale
 * jamais par la couleur seule. Les courbes, elles, portent des teintes
 * d'identité — sans quoi la même couleur voudrait dire deux choses.
 */
function NetworkMonthlyModal({ row, onClose }: { row: ProductRow; onClose: () => void }) {
    const trend = computeNetworkTrend(row.qteReseauByMonth, row.nbMagReseauByMonth);
    const { values, labels, direction, pct } = trend;
    const color = TREND_COLOR[direction];
    const magasins = computeStoresSeries(row.nbMagReseauByMonth);
    const Fleche = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;

    const dernier = values.length - 1;
    const fmt = (v: number, d = 0) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
    const verdict = trend.nouveau
        ? "Nouveau"
        : pct != null
            ? `${pct >= 0 ? "+" : ""}${Math.round(pct * 100)} %`
            : "—";

    return (
        <DialogContent className="max-w-2xl" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }} onInteractOutside={onClose}>
            <DialogHeader>
                <DialogTitle className="text-lg leading-snug pr-6" style={{ color: "var(--text-primary)" }}>
                    {row.libelle1}
                </DialogTitle>
                <p className="text-[13px] mt-1" style={{ color: "var(--text-muted)" }}>
                    Réseau · 12 mois glissants, mois en cours exclu
                </p>
            </DialogHeader>

            {!trend.hasData ? (
                <div className="mt-3 rounded-xl p-4 text-center text-[13px]" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                    Pas encore de détail mensuel pour ce produit.<br />Relancez un Sync Qlik pour le remplir.
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap gap-2 mt-1">
                        <TuileStat
                            label="Tendance"
                            valeur={verdict}
                            indice={trend.surQteParMagasin
                                ? `${trendLabel(pct, trend.nouveau)} · sur la qté/magasin`
                                : `${trendLabel(pct, trend.nouveau)} · sur les volumes (magasins inconnus)`}
                            couleur={color}
                            icone={Fleche}
                        />
                        {trend.perStore && (
                            <TuileStat
                                label="Qté / magasin"
                                valeur={fmt(trend.perStore[dernier], trend.perStore[dernier] < 10 ? 1 : 0)}
                                indice={`dernier mois · ${fmt(trend.perStore.reduce((t, v) => t + v, 0) / trend.perStore.length, 1)} en moyenne`}
                            />
                        )}
                        <TuileStat
                            label="Magasins vendeurs"
                            valeur={magasins ? fmt(magasins.values[dernier]) : fmt(row.nbMagasinsReseau ?? 0)}
                            indice={`sur ${NB_MAGASINS_RESEAU} du réseau`}
                        />
                    </div>
                    <NetworkLineChart labels={labels} values={values} stores={magasins?.values} perStore={trend.perStore} />
                </>
            )}
        </DialogContent>
    );
}

function CellDetailModal({ d, activeMagasin, onClose }: { d: CellDetailData; activeMagasin: string; onClose: () => void }) {
    const hasReceptions = (d.receptions ?? 0) > 0;
    const storeLabel = activeMagasin === "TOTAL" ? "Total réseau" : (SITE_LABELS[activeMagasin]?.nom ?? activeMagasin);

    return (
        <DialogContent className="max-w-sm" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }} onInteractOutside={onClose}>
            <DialogHeader>
                <DialogTitle className="text-base leading-snug pr-6" style={{ color: "var(--text-primary)" }}>
                    {d.row.libelle1}
                </DialogTitle>
                <p className="text-[12px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {formatMonthLabel(d.monthKey)}{" · "}
                    <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{storeLabel}</span>
                </p>
            </DialogHeader>

            <div className="grid grid-cols-3 gap-3 mt-1">
                {/* Ventes */}
                <div className="flex flex-col items-center gap-1.5 rounded-xl p-3" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                    <ShoppingCart className="w-4 h-4 opacity-60" style={{ color: "var(--text-muted)" }} />
                    <span className="text-[22px] font-black tabular-nums leading-none" style={{ color: "var(--text-primary)" }}>
                        {d.qty != null ? Math.round(d.qty).toLocaleString("fr-FR") : "—"}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Ventes</span>
                </div>

                {/* Entrées */}
                <div
                    className="flex flex-col items-center gap-1.5 rounded-xl p-3"
                    style={{
                        background: hasReceptions ? "rgba(16,185,129,0.08)" : "var(--bg-elevated)",
                        border: `1px solid ${hasReceptions ? "rgba(16,185,129,0.25)" : "var(--border)"}`,
                    }}
                >
                    <PackageOpen className="w-4 h-4" style={{ color: hasReceptions ? "rgb(16,185,129)" : "var(--text-muted)" }} />
                    <span className="text-[22px] font-black tabular-nums leading-none" style={{ color: hasReceptions ? "rgb(16,185,129)" : "var(--text-primary)" }}>
                        {hasReceptions ? `+${Math.round(d.receptions!).toLocaleString("fr-FR")}` : "—"}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Entrées</span>
                </div>

                {/* Stock fin de mois */}
                <div className="flex flex-col items-center gap-1.5 rounded-xl p-3" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                    <Warehouse className="w-4 h-4 opacity-60" style={{ color: "var(--text-muted)" }} />
                    <span className="text-[22px] font-black tabular-nums leading-none" style={{ color: "var(--text-primary)" }}>
                        {d.stock != null ? Math.round(d.stock).toLocaleString("fr-FR") : "—"}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-center" style={{ color: "var(--text-muted)" }}>Stock fin mois</span>
                </div>
            </div>

            {/*
              * En « tous magasins », les trois tuiles ci-dessus sont des cumuls.
              * Le détail par magasin est justement ce qu'on vient vérifier ici :
              * savoir que le stock est de 40 ne dit pas s'il est réparti ou
              * entièrement sur un seul site.
              */}
            {activeMagasin === "TOTAL" && <VentilationParMagasin d={d} />}
        </DialogContent>
    );
}

/** Détail ventes / entrées / stock du mois, magasin par magasin. */
function VentilationParMagasin({ d }: { d: CellDetailData }) {
    const sites = [...new Set([
        ...Object.keys(d.row.sales12mByStore ?? {}),
        ...Object.keys(d.row.stock12mByStore ?? {}),
    ])].sort();

    if (sites.length === 0) return null;

    return (
        <div className="mt-3 rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            <table className="w-full text-[11px]">
                <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                        <th className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Magasin</th>
                        <th className="text-right px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Ventes</th>
                        <th className="text-right px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Entrées</th>
                        <th className="text-right px-2.5 py-1.5 font-semibold" style={{ color: "var(--text-secondary)" }}>Stock</th>
                    </tr>
                </thead>
                <tbody>
                    {sites.map((site) => {
                        const ventes = d.row.sales12mByStore?.[site]?.[d.monthKey] ?? 0;
                        const entrees = d.row.receptions12mByStore?.[site]?.[d.monthKey] ?? 0;
                        const stock = d.row.stock12mByStore?.[site]?.[d.monthKey] ?? 0;
                        return (
                            <tr key={site} style={{ borderTop: "1px solid var(--border)" }}>
                                <td className="px-2.5 py-1.5" style={{ color: "var(--text-primary)" }}>
                                    {SITE_LABELS[site]?.nom ?? site}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums" style={{ color: "var(--text-secondary)" }}>
                                    {Math.round(ventes).toLocaleString("fr-FR")}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums" style={{ color: entrees > 0 ? "rgb(16,185,129)" : "var(--text-muted)" }}>
                                    {entrees > 0 ? `+${Math.round(entrees).toLocaleString("fr-FR")}` : "—"}
                                </td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold" style={{ color: "var(--text-primary)" }}>
                                    {Math.round(stock).toLocaleString("fr-FR")}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// =========================================================================

export function HeatmapGrid({ onSelectionChange, isAdmin }: HeatmapGridProps) {
    // L'abonnement doit être minimal ici ! PAS de draftChanges ni de setDraftGamme.
    const rows = useGridStore((s) => s.rows);
    const filters = useGridStore((s) => s.filters);
    const displayDensity = useGridStore((s) => s.displayDensity);
    const draftChanges = useGridStore((s) => s.filters.codeGamme ? s.draftChanges : EMPTY_DRAFT_CHANGES);
    const activeMagasin = useGridStore((s) => s.activeMagasin);
    const showMonthlySales = useGridStore((s) => s.showMonthlySales);
    const setShowMonthlySales = useGridStore((s) => s.setShowMonthlySales);
    const showPrices = useGridStore((s) => s.showPrices);
    const setShowPrices = useGridStore((s) => s.setShowPrices);

    // Filtre client-side par code3 (famille) et codeGamme
    const filteredData = useMemo(() => {
        const { code3, codeGamme } = filters;
        // Garde : un état persisté d'une version antérieure peut encore contenir
        // une chaîne. La migration du store le corrige, mais un `new Set("320211")`
        // produirait un ensemble de caractères et viderait la Grille sans rien dire.
        const codes = Array.isArray(code3) ? code3 : typeof code3 === "string" ? [code3] : null;
        if (!codes && !codeGamme) return rows;
        // Set plutôt que includes() : la liste peut compter des dizaines de
        // nomenclatures, et le filtre est réévalué pour chaque ligne.
        const nomenclatures = codes ? new Set(codes) : null;
        return rows.filter(r => {
            if (nomenclatures && !nomenclatures.has(r.code3)) return false;
            if (codeGamme) {
                const g = draftChanges[r.codein] ?? r.codeGamme ?? "";
                const norm = g.trim() === "" ? "Aucune" : g;
                if (norm !== codeGamme) return false;
            }
            return true;
        });
    }, [rows, filters, draftChanges]);

    const [sorting, setSorting] = useState<SortingState>([]);
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const columnVisibility = useGridStore((s) => s.columnVisibility);
    const setColumnVisibility = useGridStore((s) => s.setColumnVisibility);
    const columnSizing = useGridStore((s) => s.columnSizing);
    const setColumnSizing = useGridStore((s) => s.setColumnSizing);
    const [isMounted, setIsMounted] = useState(false);
    const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

    // État pour le détail d'une cellule mensuelle (modal)
    const [cellDetail, setCellDetail] = useState<CellDetailData | null>(null);
    const [networkModal, setNetworkModal] = useState<ProductRow | null>(null);
    // Détail 12 mois du produit, ouvert depuis la case de total
    const [monthlyModal, setMonthlyModal] = useState<ProductRow | null>(null);
    const tableContainerRef = useRef<HTMLDivElement>(null);

    // Calculer les mois dynamiquement pour éviter le mismatch entre serveur et client
    const MONTHS_12 = useMemo(() => getLast12Months(), []);

    useEffect(() => {
        setIsMounted(true);
        const container = document.getElementById('grid-toolbar-actions');
        setPortalContainer(container);
    }, []);

    const rowHeight = displayDensity === "compact" ? 32 : displayDensity === "normal" ? 40 : 48;

    const handleRowSelectionChange = useCallback(
        (updater: React.SetStateAction<RowSelectionState>) => {
            setRowSelection(updater);
        },
        []
    );

    // Reset selection when rows change (e.g. supplier change)
    useEffect(() => {
        setRowSelection({});
    }, [rows]);

    const prevSelectionRef = useRef<string[]>([]);

    // Propagate selection changes via useEffect to avoid "update during render" error
    useEffect(() => {
        if (!onSelectionChange) return;

        const selectedIdxs = Object.keys(rowSelection).filter((k) => rowSelection[k]);
        const selectedCodeins = selectedIdxs
            .map((idx) => filteredData[parseInt(idx)]?.codein ?? "")
            .filter(Boolean);

        // Only update if selection actually changed to avoid re-render loops & console warnings
        const currentString = JSON.stringify(selectedCodeins);
        const prevString = JSON.stringify(prevSelectionRef.current);

        if (currentString !== prevString) {
            prevSelectionRef.current = selectedCodeins;
            // Delay update to next tick to ensure we're out of any render cycles
            setTimeout(() => onSelectionChange(selectedCodeins), 0);
        }
    }, [rowSelection, onSelectionChange, filteredData]);

    const columns = React.useMemo<ColumnDef<ProductRow>[]>(() => [
        {
            id: "select",
            size: 36,
            header: ({ table }) => (
                <input
                    type="checkbox"
                    checked={table.getIsAllRowsSelected()}
                    ref={(el) => { if (el) el.indeterminate = table.getIsSomeRowsSelected(); }}
                    onChange={table.getToggleAllRowsSelectedHandler()}
                    className="accent-emerald-500 cursor-pointer"
                />
            ),
            cell: ({ row }) => (
                <input
                    type="checkbox"
                    checked={row.getIsSelected()}
                    onChange={row.getToggleSelectedHandler()}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-emerald-500 cursor-pointer"
                />
            ),
        },
        {
            accessorKey: "codein",
            header: "Code interne",
            size: 90,
            cell: ({ getValue }) => (
                <CopiableCell
                    value={getValue<string>()}
                    titre="Copier le code interne"
                    className="tabular-nums font-bold text-[12px] tracking-tight opacity-70 group-hover:opacity-100"
                    style={{ color: "var(--text-muted)" }}
                />
            ),
        },
        {
            accessorKey: "reference",
            header: "Référence",
            size: 110,
            cell: ({ getValue }) => (
                <CopiableCell
                    value={getValue<string>()}
                    titre="Copier la référence"
                    className="text-[12px] font-mono opacity-80 group-hover:opacity-100"
                    style={{ color: "var(--text-secondary)" }}
                />
            ),
        },
        {
            accessorKey: "gtin",
            header: "EAN / GTIN",
            size: 120,
            cell: ({ getValue }) => (
                <CopiableCell
                    value={getValue<string>()}
                    titre="Copier l'EAN / GTIN"
                    className="text-[12px] font-mono tracking-tight opacity-70 group-hover:opacity-100"
                    style={{ color: "var(--text-secondary)" }}
                />
            ),
        },
        {
            accessorKey: "libelle1",
            header: "Désignation",
            size: 280,
            cell: ({ row }) => {
                const r = row.original;
                const isDifferentSupplier = r.fournisseurPrincipalCode && r.fournisseurPrincipalCode !== r.codeFournisseur;
                const warnTitle = isDifferentSupplier
                    ? `Dernier fournisseur enregistré : ${r.fournisseurPrincipalNom ?? r.fournisseurPrincipalCode} (${r.fournisseurPrincipalCode}) — les ventes sont à attribuer à ce fournisseur`
                    : undefined;
                return (
                    <div className="flex items-center gap-2 overflow-hidden w-full pr-1">
                        {isDifferentSupplier && (
                            <span title={warnTitle} className="shrink-0 flex items-center">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                            </span>
                        )}
                        <span className="text-[13px] font-bold truncate flex-1" title={r.libelle1} style={{ color: "var(--text-primary)" }}>
                            {r.libelle1}
                        </span>
                        <div className="flex gap-1.5 shrink-0">
                            {r.workingStores.map((magasin) => {
                                const config = getStoreConfig(magasin);
                                const lastLivDate = r.derniereLivraisonByStore?.[magasin];
                                const storeName = SITE_LABELS[magasin]?.nom ?? magasin;
                                const tooltipTitle = `Magasin : ${storeName}\n${
                                    lastLivDate
                                        ? `Dernière entrée en stock : ${formatDate(lastLivDate)}`
                                        : "Aucune entrée enregistrée"
                                }`;
                                return (
                                    <div
                                        key={magasin}
                                        title={tooltipTitle}
                                        className="px-1.5 py-0.5 rounded-md flex items-center gap-1 text-[10px] font-black border shadow-sm transition-transform hover:scale-110"
                                        style={{
                                            background: config.bg,
                                            borderColor: config.border,
                                            color: config.text,
                                        }}
                                    >
                                        <Store className="w-2.5 h-2.5" strokeWidth={3} />
                                        <span>{config.label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            },
        },
        {
            accessorKey: "libelle3",
            header: "Famille",
            size: 200,
            cell: ({ row }) => {
                const code = row.original.code3;
                const label = row.original.libelle3;
                const display = code && label ? `${code} — ${label}` : (label || code || "");
                return (
                    <span className="text-[12px] truncate block text-left w-full opacity-70" style={{ color: "var(--text-secondary)" }} title={display}>
                        {display}
                    </span>
                );
            },
        },
        {
            id: "caReseau",
            accessorFn: (row) => valeurTriable(row.caReseau),
            sortUndefined: "last" as const,
            header: () => <div className="text-center w-full">CA<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 90,
            cell: ({ row }) => {
                const val = row.original.caReseau;
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold text-emerald-600 dark:text-emerald-400">
                        {val != null ? val.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }) : "-"}
                    </div>
                );
            },
        },
        {
            id: "qteReseau",
            accessorFn: (row) => valeurTriable(row.qteReseau),
            sortUndefined: "last" as const,
            header: () => <div className="text-center w-full">Qté<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 80,
            cell: ({ row }) => {
                const val = row.original.qteReseau;
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold" style={{ color: "var(--text-secondary)" }}>
                        {val != null ? Math.round(val).toLocaleString("fr-FR") : "-"}
                    </div>
                );
            },
        },
        {
            id: "nbMagasinsReseau",
            accessorFn: (row) => valeurTriable(row.nbMagasinsReseau),
            sortUndefined: "last" as const,
            header: () => <div className="text-center w-full">Magasins<br/><span className="text-[9px] opacity-60">/ 270</span></div>,
            size: 80,
            cell: ({ row }) => {
                const val = row.original.nbMagasinsReseau;
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold" style={{ color: "var(--text-secondary)" }}>
                        {val != null ? val : "-"}
                    </div>
                );
            },
        },
        {
            id: "tendanceReseau",
            accessorFn: (row) => {
                const t = computeNetworkTrend(row.qteReseauByMonth, row.nbMagReseauByMonth);
                if (!t.hasData) return Number.NEGATIVE_INFINITY;
                // Un produit « nouveau » n'a pas de pourcentage mais c'est la plus
                // forte progression possible : il doit remonter en tête du tri, pas
                // tomber au fond avec les lignes sans données.
                if (t.nouveau) return Number.POSITIVE_INFINITY;
                return t.pct ?? Number.NEGATIVE_INFINITY;
            },
            header: () => <div className="text-center w-full">Tendance<br/><span className="text-[9px] opacity-60">Réseau · 12 m</span></div>,
            size: 78,
            cell: ({ row }) => {
                const trend = computeNetworkTrend(row.original.qteReseauByMonth, row.original.nbMagReseauByMonth);
                if (!trend.hasData) return <div className="text-center text-[12px]" style={{ color: "var(--text-secondary)" }}>-</div>;
                // Cliquable → modal des ventes réseau mois par mois (12 derniers mois).
                return (
                    <button
                        type="button"
                        onClick={() => setNetworkModal(row.original)}
                        title="Voir les ventes réseau mois par mois (12 derniers mois)"
                        className="w-full cursor-pointer rounded hover:bg-[var(--bg-elevated)] transition-colors py-0.5"
                    >
                        <TrendSparkline trend={trend} />
                    </button>
                );
            },
        },
        // Bloc « prix », repliable : le prix réellement pratiqué par le réseau, et
        // celui du catalogue. Deux origines différentes, donc deux colonnes — les
        // rapprocher d'un seul écart chiffré supposerait une même assiette (HT/TTC,
        // remises), ce que les deux sources ne garantissent pas.
        ...(showPrices ? [
            {
                id: "prixMoyenReseau",
                // Même définition que la fiche produit : CA réseau ÷ quantité vendue.
                accessorFn: (row: ProductRow) => valeurTriable(prixMoyenReseau(row)),
                sortUndefined: "last" as const,
                // Sous-titre tenu court : les en-têtes ne rognent pas leur texte et
                // un libellé trop long chevauche la colonne voisine. Le détail
                // (« CA réseau ÷ quantité ») est dans l'infobulle des cellules.
                header: () => <div className="text-center w-full">PV moyen<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
                size: 88,
                cell: ({ row }: { row: { original: ProductRow } }) => {
                    const val = prixMoyenReseau(row.original);
                    return (
                        <div
                            className="text-center tabular-nums text-[12px] font-bold"
                            style={{ color: "var(--text-secondary)" }}
                            title={val != null
                                ? `Prix de vente moyen constaté sur le réseau : CA réseau ÷ quantité vendue (12 mois glissants)`
                                : "Pas de quantité réseau sur la période : le prix moyen n'a pas de sens"}
                        >
                            {val != null ? fmtEuro2(val) : "-"}
                        </div>
                    );
                },
            },
            {
                id: "prixVente",
                accessorFn: (row: ProductRow) => valeurTriable(prixVenteAffiche(row, activeMagasin).valeur),
                sortUndefined: "last" as const,
                header: () => <div className="text-center w-full">PV<br/><span className="text-[9px] opacity-60">Magasin</span></div>,
                size: 88,
                cell: ({ row }: { row: { original: ProductRow } }) => {
                    const { valeur, divergent, detail } = prixVenteAffiche(row.original, activeMagasin);
                    return (
                        <div
                            className="text-center tabular-nums text-[12px] font-bold flex items-center justify-center gap-0.5"
                            style={{ color: "var(--text-primary)" }}
                            title={valeur != null
                                ? `Prix de vente en base (cube_pv)${detail ? ` — ${detail}` : ""}`
                                : "Aucun prix de vente en base pour cet article"}
                        >
                            {valeur != null ? fmtEuro2(valeur) : "-"}
                            {/* Prix différents d'un magasin à l'autre : le signaler, la
                                cellule ne peut en afficher qu'un. */}
                            {divergent && <span className="text-[10px] font-black" style={{ color: "var(--accent-warning)" }}>≠</span>}
                        </div>
                    );
                },
            },
        ] : []),
        {
            id: "caParMagasinReseau",
            accessorFn: (row) => valeurTriable(row.caParMagasinReseau),
            sortUndefined: "last" as const,
            header: () => <div className="text-center w-full">CA / Mag<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 85,
            cell: ({ row }) => {
                const val = row.original.caParMagasinReseau;
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold" style={{ color: "var(--text-secondary)" }}>
                        {val != null ? val.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }) : "-"}
                    </div>
                );
            },
        },
        {
            id: "margePctReseau",
            accessorFn: (row) => valeurTriable(row.margePctReseau),
            sortUndefined: "last" as const,
            header: () => <div className="text-center w-full">Marge %<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 75,
            cell: ({ row }) => {
                const val = row.original.margePctReseau;
                if (val == null) return <div className="text-center text-[12px]" style={{ color: "var(--text-secondary)" }}>-</div>;
                const pct = Math.abs(val) <= 1 ? val * 100 : val;
                const color = pct >= 30 ? "text-emerald-500" : pct >= 15 ? "text-amber-500" : "text-rose-500";
                return (
                    <div className={cn("text-center font-bold text-[12px] tabular-nums", color)}>
                        {pct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%
                    </div>
                );
            },
        },
        // Bloc mensuel repliable : les colonnes sont retirées du modèle, pas
        // seulement cachées — inutile de faire calculer douze cellules par ligne
        // à TanStack pour ne rien peindre. Le détail reste accessible d'un clic
        // sur la case de total.
        ...(showMonthlySales ? MONTHS_12.map((monthKey) => ({
            id: `month_${monthKey}`,
            header: () => <div className="text-center w-full">{formatMonthLabel(monthKey)}</div>,
            size: 68,
            enableSorting: false,
            cell: ({ row }: { row: { original: ProductRow } }) => {
                const qty = activeMagasin === "TOTAL"
                    ? (row.original.sales12m[monthKey] ?? null)
                    : (row.original.sales12mByStore?.[activeMagasin]?.[monthKey] ?? null);
                const stock = activeMagasin === "TOTAL"
                    ? (row.original.stock12m[monthKey] ?? null)
                    : (row.original.stock12mByStore?.[activeMagasin]?.[monthKey] ?? null);
                const receptions = activeMagasin === "TOTAL"
                    ? (row.original.receptions12m[monthKey] ?? null)
                    : (row.original.receptions12mByStore?.[activeMagasin]?.[monthKey] ?? null);
                return (
                    <HeatmapCell
                        value={qty}
                        tooltipStock={stock}
                        tooltipReceptions={receptions}
                        onClick={(e) => {
                            e.stopPropagation();
                            setCellDetail({ row: row.original, monthKey, qty, stock, receptions });
                        }}
                    />
                );
            },
        })) : []),
        {
            id: "totalQuantite",
            accessorFn: (row: ProductRow) => activeMagasin === "TOTAL" ? row.totalQuantite : (row.quantiteByStore?.[activeMagasin] ?? 0),
            header: () => <div className="text-center w-full">Tot. 12m</div>,
            size: 90,
            cell: ({ row }: { row: { original: ProductRow } }) => {
                const qty = activeMagasin === "TOTAL"
                    ? row.original.totalQuantite
                    : (row.original.quantiteByStore?.[activeMagasin] ?? 0);
                // Cliquable → détail 12 mois : ventes, entrées en stock, stock par
                // magasin. `stopPropagation` sinon le clic sélectionne la ligne.
                return (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setMonthlyModal(row.original);
                        }}
                        title="Voir le détail des 12 mois : ventes mensuelles, entrées en stock et stock par magasin"
                        className="mx-auto w-[60px] text-center px-1 tabular-nums text-sm font-black py-1.5 rounded-md border cursor-pointer transition-all hover:brightness-110 active:scale-95"
                        style={{
                            background: "var(--bg-elevated)",
                            color: "var(--text-primary)",
                            borderColor: "var(--border-strong)"
                        }}
                    >
                        {Math.round(qty).toLocaleString("fr-FR")}
                    </button>
                );
            },
        },
        {
            id: "totalCa",
            accessorFn: (row: ProductRow) => activeMagasin === "TOTAL" ? row.totalCa : (row.caByStore?.[activeMagasin] ?? 0),
            header: () => <div className="text-center w-full">CA</div>,
            size: 90,
            cell: ({ row }: { row: { original: ProductRow } }) => {
                const ca = activeMagasin === "TOTAL"
                    ? row.original.totalCa
                    : (row.original.caByStore?.[activeMagasin] ?? 0);
                return (
                    <div className="text-center tabular-nums text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
                        {Math.round(ca).toLocaleString("fr-FR")}&nbsp;€
                    </div>
                );
            },
        },
        {
            id: "totalMarge",
            accessorFn: (row: ProductRow) => activeMagasin === "TOTAL" ? row.totalMarge : (row.margeByStore?.[activeMagasin] ?? 0),
            header: () => <div className="text-center w-full">Marge</div>,
            size: 110,
            cell: ({ row }: { row: { original: ProductRow } }) => {
                const marge = activeMagasin === "TOTAL"
                    ? row.original.totalMarge
                    : (row.original.margeByStore?.[activeMagasin] ?? 0);
                const ca = activeMagasin === "TOTAL"
                    ? row.original.totalCa
                    : (row.original.caByStore?.[activeMagasin] ?? 0);
                const taux = ca > 0 ? (marge / ca) * 100 : 0;
                return (
                    <div className="flex flex-col items-center justify-center">
                        <span className="tabular-nums text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
                            {Math.round(marge).toLocaleString("fr-FR")}&nbsp;€
                        </span>
                        <span className="tabular-nums text-[10px] font-bold opacity-70" style={{
                            color: taux >= 40 ? "var(--accent-success)" : taux >= 25 ? "var(--accent-warning)" : "var(--accent-error)"
                        }}>
                            {taux.toFixed(1)}%
                        </span>
                    </div>
                );
            },
        },
        {
            id: "gammeInitial",
            header: () => <div className="text-center w-full print:hidden">Init.</div>,
            size: 56,
            cell: ({ row }) => (
                <div className="text-center font-bold text-[12px] print:hidden" style={{ color: "var(--text-secondary)" }}>
                    {row.original.codeGammeInit || "-"}
                </div>
            ),
        },
        {
            id: "gamme",
            header: () => <div className="text-center w-full">Gamme</div>,
            size: 110,
            cell: ({ row }) => <GammeCell row={row.original} isAdmin={isAdmin} />,
        },
        // `sorting` ne figure plus en dépendance : plus aucun accesseur ne le lit
        // depuis que `sortUndefined` remplace les sentinelles. Les colonnes ne se
        // reconstruisent donc plus à chaque clic sur un en-tête.
    ], [MONTHS_12, activeMagasin, isAdmin, showMonthlySales, showPrices]); // activeMagasin déclenche re-render des cellules mensuelles et totaux

    const table = useReactTable({
        data: filteredData,
        columns,
        state: { sorting, globalFilter: filters.search, rowSelection, columnVisibility, columnSizing },
        onSortingChange: setSorting,
        onRowSelectionChange: handleRowSelectionChange,
        onColumnVisibilityChange: setColumnVisibility,
        onColumnSizingChange: setColumnSizing,
        columnResizeMode: "onChange",
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        enableRowSelection: true,
        globalFilterFn: (row, _columnId, filterValue) => {
            const search = String(filterValue).toLowerCase();
            const libelle = String(row.original.libelle1 || "").toLowerCase();
            const code = String(row.original.codein || "").toLowerCase();
            const reference = String(row.original.reference || "").toLowerCase();
            const gtin = String(row.original.gtin || "").toLowerCase();
            return libelle.includes(search) || code.includes(search) || reference.includes(search) || gtin.includes(search);
        },
    });

    const { rows: tableRows } = table.getRowModel();

    const rowVirtualizer = useVirtualizer({
        count: tableRows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan: 8,
    });

    const visibleColumns = table.getVisibleLeafColumns();
    const totalWidth = visibleColumns.reduce((s, c) => s + ((c.columnDef as { size?: number }).size ?? 150), 0);
    // Signature du jeu de colonnes affiché : elle sert de signal de re-rendu aux
    // lignes virtuelles (cf. `GridRow`). Calculée une fois par rendu de grille,
    // pas une fois par ligne.
    const columnsKey = visibleColumns.map((c) => c.id).join("|");
    /** Blocs de colonnes affichés — badge du menu « Vues ». */
    const nbVues = (showMonthlySales ? 1 : 0) + (showPrices ? 1 : 0);

    if (!isMounted) {
        return (
            <div
                className="h-full w-full overflow-auto rounded-[12px] flex items-center justify-center"
                style={{
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                }}
            >
                <div className="text-muted text-sm italic opacity-50">Chargement de la grille...</div>
            </div>
        );
    }

    return (
        <>
        <div className="h-full w-full relative">
            {portalContainer && createPortal(
                <div className="flex items-center gap-2.5">
                {/*
                  * « Vues » replie des BLOCS de colonnes d'un geste, là où le menu
                  * « Colonnes » voisin agit colonne par colonne. Douze cellules
                  * mensuelles ou deux prix ne se masquent pas une par une.
                  */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-semibold border transition-all shadow-sm apple-btn-secondary"
                            style={nbVues > 0
                                ? { background: "var(--accent-bg)", borderColor: "var(--accent-border)", color: "var(--accent)" }
                                : { background: "var(--action-secondary-bg)", borderColor: "var(--border-strong)", color: "var(--action-secondary-text)" }}
                            title="Afficher ou masquer les blocs de colonnes : ventes mensuelles, prix"
                            aria-label="Afficher ou masquer les blocs de colonnes"
                        >
                            {nbVues > 0 ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                            <span className="hidden lg:inline">Vues</span>
                            <span className="text-[11px] font-bold tabular-nums opacity-70">{nbVues}/2</span>
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[280px] z-50">
                        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                            Blocs de colonnes
                        </DropdownMenuLabel>
                        <DropdownMenuCheckboxItem
                            checked={showMonthlySales}
                            onCheckedChange={(v) => setShowMonthlySales(!!v)}
                            onSelect={(e: Event) => e.preventDefault()}
                            className="cursor-pointer"
                        >
                            <span className="flex items-center gap-2">
                                <CalendarRange className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                                <span className="flex flex-col">
                                    <span className="text-xs font-semibold">Ventes mensuelles</span>
                                    <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                                        12 mois · détail au clic sur le total
                                    </span>
                                </span>
                            </span>
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                            checked={showPrices}
                            onCheckedChange={(v) => setShowPrices(!!v)}
                            onSelect={(e: Event) => e.preventDefault()}
                            className="cursor-pointer"
                        >
                            <span className="flex items-center gap-2">
                                <Tag className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
                                <span className="flex flex-col">
                                    <span className="text-xs font-semibold">Prix</span>
                                    <span className="text-[10.5px]" style={{ color: "var(--text-muted)" }}>
                                        PV moyen réseau · PV central
                                    </span>
                                </span>
                            </span>
                        </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-semibold bg-[var(--action-secondary-bg)] text-[var(--action-secondary-text)] border border-[var(--border-strong)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all shadow-sm apple-btn-secondary"
                            aria-label="Afficher/masquer les colonnes"
                        >
                            <SlidersHorizontal className="w-4 h-4" />
                            Colonnes
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[220px] max-h-[50vh] overflow-y-auto z-50">
                        {table
                            .getAllLeafColumns()
                            .filter((column: Column<ProductRow, unknown>) => column.getCanHide())
                            .map((column: Column<ProductRow, unknown>) => {
                                return (
                                    <DropdownMenuCheckboxItem
                                        key={column.id}
                                        className="capitalize text-xs cursor-pointer font-medium"
                                        checked={column.getIsVisible()}
                                        onCheckedChange={(value) => column.toggleVisibility(!!value)}
                                        onSelect={(e: Event) => e.preventDefault()}
                                    >
                                        {typeof column.columnDef.header === 'string'
                                            ? column.columnDef.header
                                            : column.id.startsWith('month_')
                                                ? formatMonthLabel(column.id.replace('month_', ''))
                                                : column.id}
                                    </DropdownMenuCheckboxItem>
                                );
                            })}
                    </DropdownMenuContent>
                </DropdownMenu>
                </div>,
                portalContainer
            )}

            <div
                ref={tableContainerRef}
                className="h-full w-full overflow-auto rounded-[14px] relative"
                style={{
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-md)"
                }}
            >
                <table className="text-sm block" style={{ width: "100%", minWidth: totalWidth }}>
                    <thead className="sticky top-0 z-10 block" style={{
                        background: "linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface))",
                        borderBottom: "1px solid var(--border-strong)",
                        backdropFilter: "blur(10px)",
                        WebkitBackdropFilter: "blur(10px)"
                    }}>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id} className="flex w-full">
                                {headerGroup.headers.map((header) => {
                                    const isFlexible = header.column.id === "libelle1" || header.column.id === "libelle3";
                                    const isCenter = header.column.id === "totalQuantite" || header.column.id === "totalCa" || header.column.id === "totalMarge" || header.column.id.startsWith("month_") || header.column.id === "gammeInitial" || QLIK_NETWORK_COLUMN_IDS.has(header.column.id) || header.column.id === "prixVente" || header.column.id === "gamme";
                                    const size = header.getSize();
                                    return (
                                        <th
                                            key={header.id}
                                            className="px-2 py-3 text-[10px] font-black uppercase tracking-[0.05em] whitespace-nowrap select-none flex items-center transition-colors hover:bg-white/5 relative group/header"
                                            style={{
                                                width: isFlexible ? "100%" : size,
                                                flex: isFlexible ? `1 1 ${size}px` : `0 0 ${size}px`,
                                                minWidth: size,
                                                maxWidth: isFlexible ? "none" : size,
                                                color: "var(--text-muted)",
                                                justifyContent: isCenter ? "center" : "flex-start"
                                            }}
                                            onClick={header.column.getToggleSortingHandler()}
                                        >
                                            <div className={`flex items-center gap-1.5 cursor-pointer ${isCenter ? "justify-center w-full" : ""}`}>
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                                {header.column.getCanSort() && (
                                                    <div className="shrink-0 opacity-40">
                                                        {header.column.getIsSorted() === "asc" ? <ChevronUp className="w-3 h-3 text-emerald-500" />
                                                            : header.column.getIsSorted() === "desc" ? <ChevronDown className="w-3 h-3 text-emerald-500" />
                                                                : <ChevronsUpDown className="w-3 h-3" />
                                                        }
                                                    </div>
                                                )}
                                            </div>
                                            {/* Handle de redimensionnement de la colonne */}
                                            {header.column.getCanResize() && (
                                                <div
                                                    onMouseDown={header.getResizeHandler()}
                                                    onTouchStart={header.getResizeHandler()}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className={`absolute right-0 top-0 h-full w-1.5 cursor-col-resize user-select-none touch-none hover:bg-emerald-500/50 ${header.column.getIsResizing() ? "bg-emerald-500" : ""}`}
                                                />
                                            )}
                                        </th>
                                    );
                                })}
                            </tr>
                        ))}
                    </thead>
                    {/*
                      * La clé porte AUSSI la signature des colonnes : changer de jeu de
                      * colonnes remonte le corps du tableau au lieu de compter sur la
                      * comparaison de props de `React.memo`. Une ligne mémoïsée qui rate
                      * le signal continue de peindre l'ancien jeu de cellules, et la
                      * grille se retrouve à deux vitesses — en-tête à jour, corps en
                      * retard. Un remontage ne coûte que les ~30 lignes virtualisées, et
                      * le redimensionnement (continu) ne le déclenche pas : les
                      * identifiants de colonnes ne changent pas.
                      */}
                    <tbody key={`${displayDensity}|${columnsKey}`} style={{ height: rowVirtualizer.getTotalSize(), position: "relative", display: "block" }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const row = tableRows[virtualRow.index];
                            const isSelected = row.getIsSelected();

                            return (
                                <div key={row.id} style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}>
                                    <GridRow
                                        virtualRow={virtualRow}
                                        row={row}
                                        rowHeight={rowHeight}
                                        isSelected={isSelected}
                                        columnsKey={columnsKey}
                                        columnSizing={columnSizing}
                                    />
                                </div>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>

        {/* Modal détail cellule mensuelle */}
        <Dialog open={cellDetail !== null} onOpenChange={(open) => { if (!open) setCellDetail(null); }}>
            {cellDetail !== null && <CellDetailModal d={cellDetail!} activeMagasin={activeMagasin} onClose={() => setCellDetail(null)} />}
        </Dialog>
        <Dialog open={networkModal !== null} onOpenChange={(open) => { if (!open) setNetworkModal(null); }}>
            {networkModal !== null && <NetworkMonthlyModal row={networkModal} onClose={() => setNetworkModal(null)} />}
        </Dialog>
        {/* Modal détail 12 mois (ventes / entrées / stock par magasin) */}
        <Dialog open={monthlyModal !== null} onOpenChange={(open) => { if (!open) setMonthlyModal(null); }}>
            {monthlyModal !== null && (
                <ProductMonthlyModal
                    row={monthlyModal}
                    mois={MONTHS_12}
                    activeMagasin={activeMagasin}
                    onClose={() => setMonthlyModal(null)}
                />
            )}
        </Dialog>
        </>
    );
}
