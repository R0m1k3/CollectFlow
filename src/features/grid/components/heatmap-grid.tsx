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
import { ChevronUp, ChevronDown, ChevronsUpDown, Copy, Check, Store, SlidersHorizontal, ShoppingCart, PackageOpen, Warehouse, AlertTriangle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GammeSelect } from "@/features/grid/components/gamme-select";
import { HeatmapCell } from "@/features/grid/components/heatmap-cell";
import type { ProductRow, GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";

function getLast12Months(): string[] {
    const months: string[] = [];
    const now = new Date();
    // On commence à i=12 (il y a 12 mois) et on finit à i=1 (le mois dernier)
    // pour exclure le mois en cours (i=0)
    for (let i = 12; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return months;
}

// La constante est supprimée d'ici pour éviter le mismatch d'hydratation (new Date() au runtime module)

function formatMonthLabel(key: string): string {
    const m = parseInt(key.slice(4, 6), 10);
    const names = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
    return `${names[m - 1]} ${key.slice(2, 4)}`;
}

function formatDate(iso?: string): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Returns premium styling and color for stores based on the store name's hash.
 * This guarantees a consistent color for a given store, regardless of its position in the list.
 */
const SITE_LABELS: Record<string, { label: string; nom: string }> = {
    "292": { label: "F", nom: "Frouard (Nancy)" },
    "579": { label: "H", nom: "Houdemont" },
};

function getStoreConfig(name: string) {
    const known = SITE_LABELS[name];
    const words = (known?.nom ?? name).trim().split(/\s+/);
    let label = known?.label ?? words[0].charAt(0).toUpperCase();
    if (!known && words.length > 1) {
        label += words[1].charAt(0).toUpperCase();
    }

    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colorInt = Math.abs(hash) % 5;

    switch (colorInt) {
        case 0: return { bg: "rgba(99, 102, 241, 0.1)", text: "#818cf8", border: "rgba(99, 102, 241, 0.2)", label }; // Indigo
        case 1: return { bg: "rgba(245, 158, 11, 0.1)", text: "#fbbf24", border: "rgba(245, 158, 11, 0.2)", label }; // Amber
        case 2: return { bg: "rgba(16, 185, 129, 0.1)", text: "#10b981", border: "rgba(16, 185, 129, 0.2)", label }; // Emerald
        case 3: return { bg: "rgba(236, 72, 153, 0.1)", text: "#ec4899", border: "rgba(236, 72, 153, 0.2)", label }; // Pink
        case 4: return { bg: "rgba(14, 165, 233, 0.1)", text: "#0ea5e9", border: "rgba(14, 165, 233, 0.2)", label }; // Sky
        default: return { bg: "var(--bg-elevated)", text: "var(--text-muted)", border: "var(--border)", label };
    }
}

interface HeatmapGridProps {
    onSelectionChange?: (codeins: string[]) => void;
    isAdmin?: boolean;
}

const EMPTY_DRAFT_CHANGES: Record<string, GammeCode> = {};

// =========================================================================
// OPTIMISATION PERFORMANCES (React.memo + Zustand Selectors granulaires)
// =========================================================================

// 1. Composant isolé pour la Cellule Gamme (évite le re-render des colonnes)
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
    columnVisibility: Record<string, boolean>;
    columnSizing: Record<string, number>;
}

const GridRow = React.memo(({ virtualRow, row, rowHeight, isSelected, columnVisibility, columnSizing }: VirtualRowProps) => {
    // Uniquement la ligne concernée écoute son propre changement pour l'effet visuel
    const effectiveGamme = useGridStore((s) => s.draftChanges[row.original.codein] ?? row.original.codeGamme);
    void columnVisibility; // Force re-render via React.memo when visibility changes
    void columnSizing; // Force re-render via React.memo when resizing columns

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
                const isCenter = cell.column.id === "totalQuantite" || cell.column.id === "totalCa" || cell.column.id === "totalMarge" || cell.column.id.startsWith("month_") || cell.column.id === "gammeInitial" || cell.column.id === "caReseau" || cell.column.id === "qteReseau" || cell.column.id === "nbMagasinsReseau" || cell.column.id === "tauxPresenceReseau" || cell.column.id === "gamme";
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
        </DialogContent>
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

    // Filtre client-side par code3 (famille) et codeGamme
    const filteredData = useMemo(() => {
        const { code3, codeGamme } = filters;
        if (!code3 && !codeGamme) return rows;
        return rows.filter(r => {
            if (code3 && r.code3 !== code3) return false;
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
            cell: ({ getValue }) => {
                const value = getValue<string>();
                // eslint-disable-next-line react-hooks/rules-of-hooks
                const [copied, setCopied] = useState(false);

                const handleCopy = (e: React.MouseEvent) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(value);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                };

                return (
                    <div
                        onClick={handleCopy}
                        className="group flex items-center gap-1.5 cursor-pointer hover:text-emerald-500 transition-colors"
                        title="Copier le code interne"
                    >
                        <span className="tabular-nums font-bold text-[12px] tracking-tight opacity-70 group-hover:opacity-100" style={{ color: "var(--text-muted)" }}>
                            {value}
                        </span>
                        <div className="shrink-0 transition-all duration-200">
                            {copied ? (
                                <Check className="w-3 h-3 text-emerald-500 animate-in zoom-in-50" />
                            ) : (
                                <Copy className="w-3 h-3 opacity-0 group-hover:opacity-40 hover:!opacity-100" />
                            )}
                        </div>
                    </div>
                );
            },
        },
        {
            accessorKey: "reference",
            header: "Référence",
            size: 110,
            cell: ({ getValue }) => {
                const val = getValue<string>();
                return (
                    <span className="text-[12px] font-mono opacity-80" style={{ color: "var(--text-secondary)" }}>
                        {val || "-"}
                    </span>
                );
            },
        },
        {
            accessorKey: "gtin",
            header: "EAN / GTIN",
            size: 120,
            cell: ({ getValue }) => {
                const val = getValue<string>();
                return (
                    <span className="text-[12px] font-mono tracking-tight opacity-70" style={{ color: "var(--text-secondary)" }}>
                        {val || "-"}
                    </span>
                );
            },
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
            accessorKey: "caReseau",
            header: () => <div className="text-center w-full">CA<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 90,
            cell: ({ getValue }) => {
                const val = getValue<number | undefined>();
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold text-emerald-600 dark:text-emerald-400">
                        {val != null ? val.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }) : "-"}
                    </div>
                );
            },
        },
        {
            accessorKey: "qteReseau",
            header: () => <div className="text-center w-full">Qté<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 80,
            cell: ({ getValue }) => {
                const val = getValue<number | undefined>();
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold" style={{ color: "var(--text-secondary)" }}>
                        {val != null ? Math.round(val).toLocaleString("fr-FR") : "-"}
                    </div>
                );
            },
        },
        {
            accessorKey: "nbMagasinsReseau",
            header: () => <div className="text-center w-full">Magasins<br/><span className="text-[9px] opacity-60">/ 270</span></div>,
            size: 80,
            cell: ({ getValue }) => {
                const val = getValue<number | undefined>();
                return (
                    <div className="text-center tabular-nums text-[12px] font-bold" style={{ color: "var(--text-secondary)" }}>
                        {val != null ? val : "-"}
                    </div>
                );
            },
        },
        {
            accessorKey: "tauxPresenceReseau",
            header: () => <div className="text-center w-full">% Prés.<br/><span className="text-[9px] opacity-60">Réseau</span></div>,
            size: 70,
            cell: ({ getValue }) => {
                const val = getValue<number | undefined>();
                if (val == null) return <div className="text-center text-[12px]" style={{ color: "var(--text-secondary)" }}>-</div>;
                const pct = Math.round(val * 100);
                const color = pct >= 66 ? "text-emerald-500" : pct >= 33 ? "text-amber-500" : "text-rose-500";
                return (
                    <div className={cn("text-center font-black text-[13px] tabular-nums", color)}>
                        {pct}%
                    </div>
                );
            },
        },
        ...MONTHS_12.map((monthKey) => ({
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
        })),
        {
            id: "totalQuantite",
            accessorFn: (row: ProductRow) => activeMagasin === "TOTAL" ? row.totalQuantite : (row.quantiteByStore?.[activeMagasin] ?? 0),
            header: () => <div className="text-center w-full">Tot. 12m</div>,
            size: 90,
            cell: ({ row }: { row: { original: ProductRow } }) => {
                const qty = activeMagasin === "TOTAL"
                    ? row.original.totalQuantite
                    : (row.original.quantiteByStore?.[activeMagasin] ?? 0);
                return (
                    <div className="mx-auto w-[60px] text-center px-1 tabular-nums text-sm font-black py-1.5 rounded-md border" style={{
                        background: "var(--bg-elevated)",
                        color: "var(--text-primary)",
                        borderColor: "var(--border-strong)"
                    }}>
                        {Math.round(qty).toLocaleString("fr-FR")}
                    </div>
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
    ], [MONTHS_12, activeMagasin, isAdmin]); // activeMagasin déclenche re-render des cellules mensuelles et totaux

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
                </DropdownMenu>,
                portalContainer
            )}

            <div
                ref={tableContainerRef}
                className="h-full w-full overflow-auto rounded-[12px] relative"
                style={{
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-sm)"
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
                                    const isCenter = header.column.id === "totalQuantite" || header.column.id === "totalCa" || header.column.id === "totalMarge" || header.column.id.startsWith("month_") || header.column.id === "gammeInitial" || header.column.id === "caReseau" || header.column.id === "qteReseau" || header.column.id === "nbMagasinsReseau" || header.column.id === "tauxPresenceReseau" || header.column.id === "gamme";
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
                    <tbody key={displayDensity} style={{ height: rowVirtualizer.getTotalSize(), position: "relative", display: "block" }}>
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
                                        columnVisibility={columnVisibility}
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
        </>
    );
}
