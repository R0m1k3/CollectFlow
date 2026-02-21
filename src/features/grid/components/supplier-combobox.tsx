"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface Supplier {
    code: string;
    nom: string;
}

interface SupplierComboboxProps {
    fournisseurs: Supplier[];
    selectedCode: string | null;
    onSelect: (code: string) => void;
    className?: string;
}

export function SupplierCombobox({ fournisseurs, selectedCode, onSelect, className }: SupplierComboboxProps) {
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const containerRef = React.useRef<HTMLDivElement>(null);

    const selectedSupplier = fournisseurs.find((f) => f.code === selectedCode);

    const filtered = React.useMemo(() => {
        if (!search) return fournisseurs;
        const s = search.toLowerCase();
        return fournisseurs.filter(f =>
            f.nom.toLowerCase().includes(s) || f.code.toLowerCase().includes(s)
        ).slice(0, 50); // Limit display for performance
    }, [fournisseurs, search]);

    // Handle click outside to close
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
        <div className={cn("relative w-[300px]", className)} ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex items-center justify-between w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-emerald-500/50 transition-all shadow-sm group"
            >
                <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                    {selectedSupplier ? selectedSupplier.nom : "Sélectionner un fournisseur..."}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity" />
            </button>

            {open && (
                <div className="absolute top-full left-0 z-50 w-full mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="p-2 border-bottom border-slate-100 dark:border-slate-800 flex items-center gap-2">
                        <Search className="w-4 h-4 text-slate-400 shrink-0" />
                        <input
                            autoFocus
                            placeholder="Rechercher..."
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
                            filtered.map((f) => (
                                <button
                                    key={f.code}
                                    onClick={() => {
                                        onSelect(f.code);
                                        setOpen(false);
                                        setSearch("");
                                    }}
                                    className={cn(
                                        "flex items-center justify-between w-full px-3 py-2 text-sm transition-colors text-left",
                                        f.code === selectedCode
                                            ? "bg-emerald-500/10 text-emerald-600 font-bold"
                                            : "hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                                    )}
                                >
                                    <div className="flex flex-col min-w-0 pr-2">
                                        <span className="truncate">{f.nom}</span>
                                        <span className="text-[10px] opacity-50 font-mono">Code: {f.code}</span>
                                    </div>
                                    {f.code === selectedCode && (
                                        <Check className="h-4 w-4 shrink-0" />
                                    )}
                                </button>
                            ))
                        )}
                        {fournisseurs.length > 50 && !search && (
                            <div className="px-4 py-2 text-[10px] text-center text-slate-400 uppercase tracking-widest font-bold bg-slate-50/50 dark:bg-slate-800/50">
                                Saisissez pour filtrer les {fournisseurs.length} entrées
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
