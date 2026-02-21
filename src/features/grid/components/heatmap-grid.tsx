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
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { GammeSelect } from "@/features/grid/components/gamme-select";
import { HeatmapCell } from "@/features/grid/components/heatmap-cell";
import { FinancialCell } from "@/features/grid/components/financial-cell";
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

interface HeatmapGridProps {
    onSelectionChange?: (codeins: string[]) => void;
}

export function HeatmapGrid({ onSelectionChange }: HeatmapGridProps) {
    const { rows, draftChanges, setDraftGamme, filters, displayDensity } = useGridStore();
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
            cell: ({ getValue }) => <span className="font-mono-nums font-bold text-[12px] tracking-tight opacity-70" style={{ color: "var(--text-muted)" }}>{getValue<string>()}</span>,
        },
        {
            accessorKey: "libelle1",
            header: "Désignation",
            size: 280,
            cell: ({ getValue }) => (
                <span className="text-[13px] font-bold truncate block max-w-[270px]" title={getValue<string>()} style={{ color: "var(--text-primary)" }}>
                    {getValue<string>()}
                </span>
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
                    <div className={cn("text-center font-black text-[13px]", color)}>
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
                <div className="mx-auto w-[60px] text-center px-1 font-mono-nums text-sm font-black py-1.5 rounded-md border" style={{
                    background: "var(--bg-elevated)",
                    color: "var(--text-primary)",
                    borderColor: "var(--border-strong)"
                }}>
                    {Math.round(getValue<number>()).toLocaleString("fr-FR")}
                </div>
            ),
        },
        {
            id: "financial",
            header: () => <div className="text-center w-full">CA / Marge</div>,
            size: 160,
            cell: ({ row }) => (
                <FinancialCell
                    totalCa={row.original.totalCa}
                    totalMarge={row.original.totalMarge}
                    tauxMarge={row.original.tauxMarge}
                />
            ),
        },
        {
            id: "gammeInitial",
            header: () => <div className="text-center w-full">Init.</div>,
            size: 56,
            cell: ({ row }) => (
                <div className="text-center font-bold text-[12px]" style={{ color: "var(--text-secondary)" }}>
                    {row.original.codeGamme || "-"}
                </div>
            ),
        },
        {
            id: "gamme",
            header: () => <div className="text-center w-full">Gamme</div>,
            size: 110,
            cell: ({ row }) => {
                const effectiveGamme = (draftChanges[row.original.codein] ?? row.original.codeGamme) as GammeCode | null;
                return (
                    <GammeSelect
                        value={effectiveGamme}
                        isDraft={!!draftChanges[row.original.codein]}
                        onChange={(g: GammeCode) => setDraftGamme(row.original.codein, g)}
                    />
                );
            },
        },
        {
            id: "ai",
            header: "Recommandation IA",
            size: 230,
            enableSorting: false,
            cell: ({ row }) => <AiInsightBlock row={row.original} />,
        },
    ], [draftChanges, setDraftGamme, MONTHS_12]);

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
            className="overflow-auto rounded-[12px]"
            style={{
                height: "calc(100vh - 240px)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
            }}
        >
            <table className="text-sm block" style={{ width: "100%", minWidth: totalWidth }}>
                <thead className="sticky top-0 z-10 block" style={{ background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" }}>
                    {table.getHeaderGroups().map((headerGroup) => (
                        <tr key={headerGroup.id} className="flex w-full">
                            {headerGroup.headers.map((header) => {
                                const isFlexible = header.column.id === "libelle1" || header.column.id === "ai" || header.column.id === "libelle3";
                                const isCenter = header.column.id === "totalQuantite" || header.column.id === "financial" || header.column.id.startsWith("month_") || header.column.id === "gammeInitial" || header.column.id === "score" || header.column.id === "gamme";
                                const size = header.getSize();
                                return (
                                    <th
                                        key={header.id}
                                        className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap select-none flex items-center"
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
                                        <div className={`flex items-center gap-1 cursor-pointer ${isCenter ? "justify-center w-full" : ""}`}>
                                            {flexRender(header.column.columnDef.header, header.getContext())}
                                            {header.column.getCanSort() && (
                                                header.column.getIsSorted() === "asc" ? <ChevronUp className="w-3 h-3" />
                                                    : header.column.getIsSorted() === "desc" ? <ChevronDown className="w-3 h-3" />
                                                        : <ChevronsUpDown className="w-3 h-3 opacity-30" />
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
                        const effectiveGamme = draftChanges[row.original.codein] ?? row.original.codeGamme;
                        const isSelected = row.getIsSelected();
                        return (
                            <tr
                                key={row.id}
                                data-index={virtualRow.index}
                                ref={rowVirtualizer.measureElement}
                                onClick={() => row.toggleSelected()}
                                className={cn(
                                    "absolute w-full flex items-center cursor-pointer transition-colors",
                                    effectiveGamme === "Z" && "opacity-40"
                                )}
                                style={{
                                    height: `${rowHeight}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                    borderBottom: "1px solid var(--border)",
                                    background: isSelected ? "var(--accent-bg)" : undefined,
                                    borderLeft: isSelected ? "2px solid var(--accent)" : undefined,
                                }}
                            >
                                {row.getVisibleCells().map((cell) => {
                                    const isFlexible = cell.column.id === "libelle1" || cell.column.id === "ai" || cell.column.id === "libelle3";
                                    const isCenter = cell.column.id === "totalQuantite" || cell.column.id === "financial" || cell.column.id.startsWith("month_") || cell.column.id === "gammeInitial" || cell.column.id === "score";
                                    const size = cell.column.getSize();
                                    return (
                                        <td
                                            key={cell.id}
                                            className={`px-2 overflow-hidden flex items-center`}
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
                    })}
                </tbody>
            </table>
        </div>
    );
}
