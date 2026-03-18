"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Filter } from "lucide-react";
import { useGridStore } from "@/features/grid/store/use-grid-store";

interface NomenclatureFilterProps {
    options: { code: string; label: string }[];
    className?: string;
}

export function NomenclatureFilter({ options, className }: NomenclatureFilterProps) {
    const code3 = useGridStore((s) => s.filters.code3);
    const setFilter = useGridStore((s) => s.setFilter);

    return (
        <div className={cn("relative group", className)}>
            <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
                <Filter className="h-3.5 w-3.5 opacity-40 group-focus-within:opacity-100 transition-opacity" style={{ color: "var(--text-primary)" }} />
            </div>

            <select
                value={code3 ?? ""}
                onChange={(e) => setFilter("code3", e.target.value || null)}
                className="apple-input pr-12 appearance-none w-full min-w-[240px]"
                style={{ fontSize: "12px", height: "36px", paddingLeft: "36px" }}
            >
                <option value="">Toute la nomenclature</option>
                {options.map((opt) => (
                    <option key={opt.code} value={opt.code}>
                        {opt.code} — {opt.label}
                    </option>
                ))}
            </select>

            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none opacity-40">
                <ChevronDown className="h-4 w-4" />
            </div>
        </div>
    );
}
