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
    /** Libellé du bouton quand rien n'est choisi. */
    placeholder?: string;
}

/** Nombre de fournisseurs listés : la liste complète (plusieurs milliers) figeait l'ouverture. */
const AFFICHAGE_MAX = 50;

/** Choix d'un fournisseur, avec recherche par nom ou par code. */
export function SupplierCombobox({ fournisseurs, selectedCode, onSelect, className, placeholder = "Choisir un fournisseur…" }: SupplierComboboxProps) {
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const containerRef = React.useRef<HTMLDivElement>(null);

    const selectedSupplier = fournisseurs.find((f) => f.code === selectedCode);

    const { affiches, total } = React.useMemo(() => {
        const s = search.trim().toLowerCase();
        const trouves = s
            ? fournisseurs.filter((f) => f.nom.toLowerCase().includes(s) || f.code.toLowerCase().includes(s))
            : fournisseurs;
        return { affiches: trouves.slice(0, AFFICHAGE_MAX), total: trouves.length };
    }, [fournisseurs, search]);

    // Fermeture au clic à l'extérieur
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
                aria-haspopup="listbox"
                aria-expanded={open}
                className="flex h-9 w-full items-center justify-between rounded-lg border px-3 text-sm shadow-sm bg-[var(--bg-surface)] border-[var(--border-strong)] hover:border-[var(--accent)]"
            >
                <span className={cn("truncate", selectedSupplier ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-muted)]")}>
                    {selectedSupplier ? selectedSupplier.nom : placeholder}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            </button>

            {open && (
                <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-[300px] overflow-hidden rounded-xl border shadow-[var(--shadow-lg)] bg-[var(--bg-surface)] border-[var(--border-strong)] animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
                        <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                        <input
                            autoFocus
                            placeholder="Nom ou code du fournisseur…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full border-none bg-transparent py-1 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                        />
                    </div>
                    <div role="listbox" className="max-h-[320px] overflow-auto py-1">
                        {affiches.length === 0 ? (
                            <div className="px-4 py-3 text-center text-sm text-[var(--text-muted)]">
                                Aucun fournisseur ne correspond.
                            </div>
                        ) : (
                            affiches.map((f) => (
                                <button
                                    key={f.code}
                                    role="option"
                                    aria-selected={f.code === selectedCode}
                                    onClick={() => {
                                        onSelect(f.code);
                                        setOpen(false);
                                        setSearch("");
                                    }}
                                    className={cn(
                                        "flex w-full items-center justify-between px-3 py-2 text-left text-sm",
                                        f.code === selectedCode
                                            ? "bg-[var(--accent-bg)] font-semibold text-[var(--text-primary)]"
                                            : "text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]",
                                    )}
                                >
                                    <div className="flex min-w-0 flex-col pr-2">
                                        <span className="truncate">{f.nom}</span>
                                        <span className="text-xs text-[var(--text-muted)]">Code {f.code}</span>
                                    </div>
                                    {f.code === selectedCode && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                                </button>
                            ))
                        )}
                        {total > affiches.length && (
                            <div className="border-t border-[var(--border)] px-4 py-2 text-center text-xs text-[var(--text-muted)]">
                                {affiches.length} premiers sur {total.toLocaleString("fr-FR")} — précisez la recherche
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
