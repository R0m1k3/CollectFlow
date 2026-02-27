"use client";

import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
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
import { ChevronUp, ChevronDown, ChevronsUpDown, Copy, Check, Store } from "lucide-react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { GammeSelect } from "@/features/grid/components/gamme-select";
import { HeatmapCell } from "@/features/grid/components/heatmap-cell";
import type { ProductRow, GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";
import { AiInsightBlock } from "@/features/ai-copilot/components/ai-insight-block";

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

/**
 * Returns premium styling and icons for stores.
 * Indigo for first store, Amber for second, Slate for others.
 */
function getStoreConfig(name: string, index: number) {
    const initial = name.charAt(0).toUpperCase();
    if (index === 0) {
        return {
            bg: "rgba(99, 102, 241, 0.1)", // Indigo
            text: "#818cf8",
            border: "rgba(99, 102, 241, 0.2)",
            label: initial
        };
    }
    if (index === 1) {
        return {
            bg: "rgba(245, 158, 11, 0.1)", // Amber
            text: "#fbbf24",
            border: "rgba(245, 158, 11, 0.2)",
            label: initial
        };
    }
    return {
        bg: "var(--bg-elevated)",
        text: "var(--text-muted)",
        border: "var(--border)",
        label: initial
    };
}

interface HeatmapGridProps {
    onSelectionChange?: (codeins: string[]) => void;
}

// =========================================================================
// OPTIMISATION PERFORMANCES (React.memo + Zustand Selectors granulaires)
// =========================================================================

// 1. Composant isolé pour la Cellule Gamme (évite le re-render des colonnes)
const GammeCell = React.memo(({ row }: { row: ProductRow }) => {
    // Abonnement ultra-ciblé : la cellule ne re-render que si SA valeur change
    const codein = row.codein;
    const isDraft = useGridStore((s) => s.draftChanges[codein] !== undefined);
    const effectiveGamme = useGridStore((s) => s.draftChanges[codein] ?? row.codeGamme);
    const setDraftGamme = useGridStore((s) => s.setDraftGamme);

    const isModified = row.codeGamme !== row.codeGammeInit && row.codeGammeInit !== null;

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

import { Row } from "@tanstack/react-table";
import { VirtualItem } from "@tanstack/react-virtual";

// 2. Composant isolé pour la Ligne Virtuelle 
// (Gère l'état grisé "Z" localement sans faire re-render toute la grid)
interface VirtualRowProps {
    virtualRow: VirtualItem;
    row: Row<ProductRow>;
    rowHeight: number;
    isSelected: boolean;
}

const GridRow = React.memo(({ virtualRow, row, rowHeight, isSelected }: VirtualRowProps) => {
    // Uniquement la ligne concernée écoute son propre changement pour l'effet visuel
    const effectiveGamme = useGridStore((s) => s.draftChanges[row.original.codein] ?? row.original.codeGamme);

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
            {row.getVisibleCells().map((cell: any) => {
                const isFlexible = cell.column.id === "libelle1" || cell.column.id === "ai" || cell.column.id === "libelle3";
                const isCenter = cell.column.id === "totalQuantite" || cell.column.id === "totalCa" || cell.column.id === "totalMarge" || cell.column.id.startsWith("month_") || cell.column.id === "gammeInitial" || cell.column.id === "score" || cell.column.id === "gamme";
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

export function HeatmapGrid({ onSelectionChange }: HeatmapGridProps) {
    // L'abonnement doit être minimal ici ! PAS de draftChanges ni de setDraftGamme.
    const { rows, filters, displayDensity } = useGridStore();
    const [sorting, setSorting] = useState<SortingState>([]);
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [isMounted, setIsMounted] = useState(false);
    const tableContainerRef = useRef<HTMLDivElement>(null);

    // Calculer les mois dynamiquement pour éviter le mismatch entre serveur et client
    const MONTHS_12 = useMemo(() => getLast12Months(), []);

    useEffect(() => {
        setIsMounted(true);
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
            .map((idx) => rows[parseInt(idx)]?.codein ?? "")
            .filter(Boolean);

        // Only update if selection actually changed to avoid re-render loops & console warnings
        const currentString = JSON.stringify(selectedCodeins);
        const prevString = JSON.stringify(prevSelectionRef.current);

        if (currentString !== prevString) {
            prevSelectionRef.current = selectedCodeins;
            // Delay update to next tick to ensure we're out of any render cycles
            setTimeout(() => onSelectionChange(selectedCodeins), 0);
        }
    }, [rowSelection, onSelectionChange, rows]);

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
            header: "Code",
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
                        title="Copier le code"
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
            accessorKey: "libelle1",
            header: "Désignation",
            size: 280,
            cell: ({ row }) => (
                <div className="flex items-center gap-2 overflow-hidden w-full pr-1">
                    <span className="text-[13px] font-bold truncate flex-1" title={row.original.libelle1} style={{ color: "var(--text-primary)" }}>
                        {row.original.libelle1}
                    </span>
                    <div className="flex gap-1.5 shrink-0">
                        {row.original.workingStores.map((magasin, idx) => {
                            const config = getStoreConfig(magasin, idx);
                            return (
                                <div
                                    key={magasin}
                                    title={`Travaillé par : ${magasin} (${idx + 1 === 1 ? 'Magasin 1' : 'Magasin 2'})`}
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
            ),
        },
        {
            accessorKey: "libelle3",
            header: "Famille",
            size: 160,
            cell: ({ getValue }) => (
                <span className="text-[12px] truncate block text-left w-full opacity-70" style={{ color: "var(--text-secondary)" }}>
                    {getValue<string>()}
                </span>
            ),
        },
        {
            accessorKey: "score",
            header: "Score",
            size: 60,
            cell: ({ getValue }) => {
                const val = getValue<number>();
                const color = val >= 80 ? "text-emerald-500" : val >= 50 ? "text-amber-500" : "text-rose-500";
                return (
                    <div className={cn("text-center font-black text-[13px] tabular-nums", color)}>
                        {val}
                    </div>
                );
            },
        },
        ...MONTHS_12.map((monthKey) => ({
            id: `month_${monthKey}`,
            header: () => <div className="text-center w-full">{formatMonthLabel(monthKey)}</div>,
            size: 68,
            enableSorting: false,
            cell: ({ row }: { row: { original: ProductRow } }) => (
                <HeatmapCell value={row.original.sales12m[monthKey] ?? null} />
            ),
        })),
        {
            accessorKey: "totalQuantite",
            header: () => <div className="text-center w-full">Tot. 12m</div>,
            size: 90,
            cell: ({ getValue }) => (
                <div className="mx-auto w-[60px] text-center px-1 tabular-nums text-sm font-black py-1.5 rounded-md border" style={{
                    background: "var(--bg-elevated)",
                    color: "var(--text-primary)",
                    borderColor: "var(--border-strong)"
                }}>
                    {Math.round(getValue<number>()).toLocaleString("fr-FR")}
                </div>
            ),
        },
        {
            accessorKey: "totalCa",
            header: () => <div className="text-center w-full">CA</div>,
            size: 90,
            cell: ({ getValue }) => (
                <div className="text-center tabular-nums text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
                    {Math.round(getValue<number>()).toLocaleString("fr-FR")}&nbsp;€
                </div>
            ),
        },
        {
            accessorKey: "totalMarge",
            header: () => <div className="text-center w-full">Marge</div>,
            size: 110,
            cell: ({ row }) => (
                <div className="flex flex-col items-center justify-center">
                    <span className="tabular-nums text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
                        {Math.round(row.original.totalMarge).toLocaleString("fr-FR")}&nbsp;€
                    </span>
                    <span className="tabular-nums text-[10px] font-bold opacity-70" style={{
                        color: row.original.tauxMarge >= 40 ? "var(--accent-success)" : row.original.tauxMarge >= 25 ? "var(--accent-warning)" : "var(--accent-error)"
                    }}>
                        {row.original.tauxMarge.toFixed(1)}%
                    </span>
                </div>
            ),
        },
        {
            id: "gammeInitial",
            header: () => <div className="text-center w-full">Init.</div>,
            size: 56,
            cell: ({ row }) => (
                <div className="text-center font-bold text-[12px]" style={{ color: "var(--text-secondary)" }}>
                    {row.original.codeGammeInit || "-"}
                </div>
            ),
        },
        {
            id: "gamme",
            header: () => <div className="text-center w-full">Gamme</div>,
            size: 110,
            cell: ({ row }) => <GammeCell row={row.original} />,
        },
        {
            id: "ai",
            header: "Recommandation IA",
            size: 230,
            enableSorting: false,
            cell: ({ row }) => <AiInsightBlock row={row.original} />,
        },
    ], [MONTHS_12]); // Dépendances extrêmement stables : pas de re-render du header !

    const table = useReactTable({
        data: rows,
        columns,
        state: { sorting, globalFilter: filters.search, rowSelection },
        onSortingChange: setSorting,
        onRowSelectionChange: handleRowSelectionChange,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        enableRowSelection: true,
    });

    const { rows: tableRows } = table.getRowModel();

    const rowVirtualizer = useVirtualizer({
        count: tableRows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => rowHeight,
        overscan: 20,
    });

    const totalWidth = columns.reduce((s, c) => s + ((c as { size?: number }).size ?? 150), 0);

    if (!isMounted) {
        return (
            <div
                className="overflow-auto rounded-[12px] flex items-center justify-center"
                style={{
                    height: "calc(100vh - 240px)",
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border)",
                }}
            >
                <div className="text-muted text-sm italic opacity-50">Chargement de la grille...</div>
            </div>
        );
    }

    return (
        <div
            ref={tableContainerRef}
            className="overflow-auto rounded-[12px] scroll-smooth"
            style={{
                height: "calc(100vh - 240px)",
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
                                const isFlexible = header.column.id === "libelle1" || header.column.id === "ai" || header.column.id === "libelle3";
                                const isCenter = header.column.id === "totalQuantite" || header.column.id === "totalCa" || header.column.id === "totalMarge" || header.column.id.startsWith("month_") || header.column.id === "gammeInitial" || header.column.id === "score" || header.column.id === "gamme";
                                const size = header.getSize();
                                return (
                                    <th
                                        key={header.id}
                                        className="px-2 py-3 text-[10px] font-black uppercase tracking-[0.05em] whitespace-nowrap select-none flex items-center transition-colors hover:bg-white/5"
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
                            <div key={row.id} ref={rowVirtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}>
                                <GridRow
                                    virtualRow={virtualRow}
                                    row={row}
                                    rowHeight={rowHeight}
                                    isSelected={isSelected}
                                />
                            </div>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
