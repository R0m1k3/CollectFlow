"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Store {
    code: string;
    nom: string;
}

interface StoreComboboxProps {
    magasins: Store[];
    selectedCode: string | null;
    onSelect: (code: string) => void;
    className?: string;
}

export function StoreCombobox({ magasins, selectedCode, onSelect, className }: StoreComboboxProps) {
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const containerRef = React.useRef<HTMLDivElement>(null);

    const options = React.useMemo(() => [
        { code: "TOTAL", nom: "Tous les magasins (Total)" },
        ...magasins
    ], [magasins]);

    const selectedStore = options.find((s) => s.code === (selectedCode || "TOTAL"));

    const filtered = React.useMemo(() => {
        if (!search) return options;
        const s = search.toLowerCase();
        return options.filter(f =>
            f.nom.toLowerCase().includes(s) || f.code.toLowerCase().includes(s)
        ).slice(0, 50);
    }, [options, search]);

    React.useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    return (
        <div className={cn("relative w-[280px]", className)} ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex items-center justify-between w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-blue-500/50 transition-all shadow-sm group"
            >
                <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-500 transition-colors" />
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                        {selectedStore ? selectedStore.nom : "TOTAL"}
                    </span>
                </div>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </button>

            {open && (
                <div className="absolute top-full left-0 z-50 w-full mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="p-2 border-bottom border-slate-100 dark:border-slate-800 flex items-center gap-2">
                        <Search className="w-4 h-4 text-slate-400 shrink-0" />
                        <input
                            autoFocus
                            placeholder="Rechercher un magasin..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full bg-transparent border-none outline-none text-sm py-1 placeholder:text-slate-500 dark:text-white"
                        />
                    </div>
                    <div className="max-h-[300px] overflow-auto py-1 custom-scrollbar">
                        {filtered.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-slate-500 text-center italic">
                                Aucun résultat
                            </div>
                        ) : (
                            filtered.map((s) => (
                                <button
                                    key={s.code}
                                    onClick={() => {
                                        onSelect(s.code);
                                        setOpen(false);
                                        setSearch("");
                                    }}
                                    className={cn(
                                        "flex items-center justify-between w-full px-3 py-2 text-sm transition-colors text-left",
                                        s.code === (selectedCode || "TOTAL")
                                            ? "bg-blue-500/10 text-blue-600 font-bold"
                                            : "hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                                    )}
                                >
                                    <div className="flex flex-col min-w-0 pr-2">
                                        <span className="truncate">{s.nom}</span>
                                        <span className="text-[10px] opacity-50 font-mono italic">{s.code === "TOTAL" ? "Agrégation nationale" : `Magasin ID: ${s.code}`}</span>
                                    </div>
                                    {s.code === (selectedCode || "TOTAL") && (
                                        <Check className="h-4 w-4 shrink-0" />
                                    )}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
