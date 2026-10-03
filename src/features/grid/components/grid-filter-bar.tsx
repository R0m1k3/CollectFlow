"use client";

import React, { useMemo } from "react";
import { Search, X } from "lucide-react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { cn } from "@/lib/utils";
import { trouverGamme } from "@/lib/gammes";

import { SupplierCombobox } from "./supplier-combobox";
import { StoreCombobox } from "./store-combobox";
import { useRouter, useSearchParams } from "next/navigation";
import { NomenclatureFilter } from "./nomenclature-filter";

interface GridFilterBarProps {
    fournisseurs: { code: string; nom: string }[];
    magasins: { code: string; nom: string }[];
}

const EMPTY_DRAFT_CHANGES: Record<string, string> = {};

export function GridFilterBar({ fournisseurs, magasins }: GridFilterBarProps) {
    const filters = useGridStore((s) => s.filters);
    const setFilter = useGridStore((s) => s.setFilter);
    const rows = useGridStore((s) => s.rows);
    const draftChanges = useGridStore((s) => s.filters.codeGamme ? s.draftChanges : EMPTY_DRAFT_CHANGES);
    const router = useRouter();
    const searchParams = useSearchParams();
    const [searchValue, setSearchValue] = React.useState(filters.search);

    React.useEffect(() => {
        setSearchValue(filters.search);
    }, [filters.search]);

    React.useEffect(() => {
        const handle = window.setTimeout(() => {
            if (searchValue !== filters.search) {
                setFilter("search", searchValue);
            }
        }, 250);
        return () => window.clearTimeout(handle);
    }, [searchValue, filters.search, setFilter]);

    // Options nomenclature (famille) construites depuis les rows chargées
    const code3Options = useMemo(() => {
        const map = new Map<string, string>();
        rows.forEach(r => {
            if (r.code3 && r.libelle3) map.set(r.code3, r.libelle3);
        });
        return Array.from(map.entries())
            .map(([code, label]) => ({ code, label }))
            .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    }, [rows]);

    // Compute dynamic counts and present Gammes
    const { gammeCounts, activeGammes } = React.useMemo(() => {
        const counts: Record<string, number> = { Total: 0 };
        const gammesPresence = new Set<string>();

        rows.forEach(r => {
            let effectiveGamme = draftChanges[r.codein] ?? r.codeGamme;

            // Handle null, empty, or undefined gammes as "Aucune"
            if (!effectiveGamme || effectiveGamme.trim() === "") {
                effectiveGamme = "Aucune";
            }

            gammesPresence.add(effectiveGamme);
            counts[effectiveGamme] = (counts[effectiveGamme] || 0) + 1;

            if (effectiveGamme !== "Z") {
                counts.Total++; // Active references (non-Z)
            }
        });

        // Always ensure A, B, C, Z are available IF they have count > 0, plus any other discovered gammes
        const sortedGammes = Array.from(gammesPresence).sort((a, b) => {
            if (a === "Aucune") return 1; // Put "Aucune" at the end
            if (b === "Aucune") return -1;
            return a.localeCompare(b);
        });

        // Build the dynamic filter list
        const filtersList: { label: string; value: string | null }[] = [
            { label: "Tous", value: null },
            ...sortedGammes.map(g => ({ label: g, value: g }))
        ];

        return { gammeCounts: counts, activeGammes: filtersList };
    }, [rows, draftChanges]);

    const handleSupplierSelect = (code: string) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("fournisseur", code);
        router.push(`/grid?${params.toString()}`);
    };

    const setActiveMagasin = useGridStore((s) => s.setActiveMagasin);
    const activeMagasin = useGridStore((s) => s.activeMagasin);

    const handleStoreSelect = (code: string) => {
        setActiveMagasin(code);
        const params = new URLSearchParams(searchParams.toString());
        params.set("magasin", code);
        router.replace(`/grid?${params.toString()}`, { scroll: false });
    };


    return (
        <div className="flex items-center gap-3 flex-wrap">
            {/* Supplier Selector */}
            <SupplierCombobox
                fournisseurs={fournisseurs}
                selectedCode={searchParams.get("fournisseur")}
                onSelect={handleSupplierSelect}
                className="w-[200px] xl:w-[280px]"
            />

            {/* Store Selector */}
            <StoreCombobox
                magasins={magasins}
                selectedCode={activeMagasin === "TOTAL" ? null : activeMagasin}
                onSelect={handleStoreSelect}
            />

            {/* Search */}
            <div className="relative">
                <Search
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
                    style={{ color: "var(--text-muted)" }}
                />
                <input
                    type="search"
                    placeholder="Rechercher un produit (code, nom…)"
                    aria-label="Rechercher un produit dans la grille"
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                    // La croix native de `type="search"` (WebKit/Blink) est masquée :
                    // ce champ a déjà son propre bouton d'effacement juste à droite,
                    // et les deux apparaissaient côte à côte. On garde `type="search"`
                    // pour la sémantique ; le masquage est local, la recherche de
                    // l'en-tête n'ayant pas de bouton maison, elle garde le sien.
                    className="apple-input w-52 xl:w-72 pr-8 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-cancel-button]:hidden"
                    style={{ paddingLeft: "32px" }}
                />
                {searchValue && (
                    <button
                        type="button"
                        onClick={() => setSearchValue("")}
                        aria-label="Effacer la recherche"
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
                {activeGammes.map(({ label, value }) => {
                    const count = value === null ? rows.length : gammeCounts[value] || 0;
                    const isActive = filters.codeGamme === value;

                    const gamme = value ? trouverGamme(value) : undefined;
                    const titre = value === null
                        ? "Toutes les gammes"
                        : gamme
                            ? `${gamme.code} — ${gamme.nom} : ${gamme.description}`
                            : "Produits sans gamme";

                    return (
                        <button
                            key={label}
                            onClick={() => setFilter("codeGamme", value)}
                            title={titre}
                            aria-pressed={isActive}
                            className={cn(
                                "flex items-center gap-1.5 px-2.5 py-1 text-[13px] font-semibold rounded-md transition-colors",
                                isActive
                                    ? "shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
                                    : "hover:bg-[var(--bg-surface)]"
                            )}
                            style={{
                                background: isActive ? "var(--bg-surface)" : "transparent",
                                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                            }}
                        >
                            {gamme ? (
                                <span className={cn("rounded border px-1 text-xs font-bold", gamme.classes)}>{gamme.code}</span>
                            ) : null}
                            <span>{value === null ? "Toutes" : gamme ? gamme.nom : "Sans gamme"}</span>
                            <span className="text-xs font-medium tabular-nums text-[var(--text-muted)]">
                                {count.toLocaleString("fr-FR")}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Nomenclature filter */}
            <NomenclatureFilter options={code3Options} />
        </div>
    );
}
