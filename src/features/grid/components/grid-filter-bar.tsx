"use client";

import React, { useMemo } from "react";
import { Search, X, ChevronDown } from "lucide-react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { GammeCode } from "@/types/grid";
import { cn } from "@/lib/utils";

const GAMME_FILTERS: { label: string; value: GammeCode | null }[] = [
    { label: "Tous", value: null },
    { label: "A", value: "A" },
    { label: "B", value: "B" },
    { label: "C", value: "C" },
    { label: "Z", value: "Z" },
];

import { SupplierCombobox } from "./supplier-combobox";
import { StoreCombobox } from "./store-combobox";
import { useRouter, useSearchParams } from "next/navigation";
import { NomenclatureFilter } from "./nomenclature-filter";

interface GridFilterBarProps {
    fournisseurs: { code: string; nom: string }[];
    magasins: { code: string; nom: string }[];
    nomenclature: any;
}

export function GridFilterBar({ fournisseurs, magasins, nomenclature }: GridFilterBarProps) {
    const { filters, setFilter, rows, draftChanges } = useGridStore();
    const router = useRouter();
    const searchParams = useSearchParams();

    // Compute dynamic counts per Gamme
    const gammeCounts = React.useMemo(() => {
        const counts: Record<string, number> = { A: 0, B: 0, C: 0, Z: 0, Total: 0 };
        rows.forEach(r => {
            const effectiveGamme = draftChanges[r.codein] ?? r.codeGamme;
            if (effectiveGamme && counts[effectiveGamme] !== undefined) {
                counts[effectiveGamme]++;
            }
            if (effectiveGamme !== "Z") {
                counts.Total++; // Active references (non-Z)
            }
        });
        return counts;
    }, [rows, draftChanges]);

    const handleSupplierSelect = (code: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("fournisseur", code);
        router.push(`/grid?${params.toString()}`);
    };

    const handleStoreSelect = (code: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("magasin", code);
        router.push(`/grid?${params.toString()}`);
    };

    return (
        <div className="flex items-center gap-3 flex-wrap">
            {/* Supplier Selector */}
            <SupplierCombobox
                fournisseurs={fournisseurs}
                selectedCode={searchParams.get("fournisseur")}
                onSelect={handleSupplierSelect}
                className="w-[280px]"
            />

            {/* Store Selector */}
            <StoreCombobox
                magasins={magasins}
                selectedCode={searchParams.get("magasin")}
                onSelect={handleStoreSelect}
                className="w-[220px]"
            />

            {/* Search */}
            <div className="relative">
                <Search
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
                    style={{ color: "var(--text-muted)" }}
                />
                <input
                    type="search"
                    placeholder="Rechercher (code, désignation...)"
                    value={filters.search}
                    onChange={(e) => setFilter("search", e.target.value)}
                    className="apple-input w-72 pr-8"
                    style={{ paddingLeft: "32px" }}
                />
                {filters.search && (
                    <button
                        onClick={() => setFilter("search", "")}
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                    >
                        <X className="h-3.5 w-3.5 hover:opacity-100 opacity-60 transition-opacity" style={{ color: "var(--text-secondary)" }} />
                    </button>
                )}
            </div>

            {/* Gamme quick filter */}
            <div
                className="flex items-center gap-1 p-0.5 rounded-lg"
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
            >
                {GAMME_FILTERS.map(({ label, value }) => {
                    const count = value === null ? rows.length : gammeCounts[value];
                    const isActive = filters.codeGamme === value;

                    // Semantic colors for the badge based on Gamme
                    const getBadgeStyles = () => {
                        if (!isActive) return { background: "rgba(0,0,0,0.05)", color: "var(--text-muted)" };
                        switch (value) {
                            case "A": return { background: "rgba(16, 185, 129, 0.15)", color: "rgb(5, 150, 105)" }; // Emerald
                            case "B": return { background: "rgba(59, 130, 246, 0.15)", color: "rgb(37, 99, 235)" }; // Blue
                            case "C": return { background: "rgba(245, 158, 11, 0.15)", color: "rgb(217, 119, 6)" }; // Amber
                            case "Z": return { background: "rgba(244, 63, 94, 0.15)", color: "rgb(225, 29, 72)" };  // Rose
                            default: return { background: "rgba(0,0,0,0.1)", color: "var(--text-primary)" };
                        }
                    };

                    const badgeStyles = getBadgeStyles();

                    return (
                        <button
                            key={label}
                            onClick={() => setFilter("codeGamme", value)}
                            className={cn(
                                "flex items-center gap-2 px-2.5 py-1 text-[11px] font-semibold rounded-[6px] transition-all duration-200",
                                isActive
                                    ? "shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                                    : "hover:bg-[var(--bg-surface)] opacity-70 hover:opacity-100"
                            )}
                            style={{
                                background: isActive ? "var(--bg-surface)" : "transparent",
                                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                            }}
                        >
                            <span>{label}</span>
                            <span
                                className="inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-full text-[9px] font-bold tabular-nums tracking-tight transition-colors"
                                style={badgeStyles}
                            >
                                {count}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Nomenclature filter */}
            <NomenclatureFilter hierarchy={nomenclature} />
        </div>
    );
}
