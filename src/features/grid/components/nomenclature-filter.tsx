"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Filter, Search, X } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGridStore } from "@/features/grid/store/use-grid-store";

interface NomenclatureFilterProps {
    options: { code: string; label: string }[];
    className?: string;
}

/**
 * Filtre multi-nomenclatures de la Grille.
 *
 * Une liste déroulante à cases plutôt qu'un `<select>` simple : on veut pouvoir
 * en retenir plusieurs, et surtout partir de « tout » pour retirer les postes
 * dont on ne veut pas — ce qui est la manière naturelle de travailler quand un
 * fournisseur en compte des dizaines.
 *
 * Convention : `null` = aucun filtre (tout s'affiche), `[]` = rien de coché
 * (aucune ligne). Les distinguer évite la valeur sentinelle qu'imposerait un
 * simple tableau, et rend « Tout décocher » possible sans ambiguïté.
 */
export function NomenclatureFilter({ options, className }: NomenclatureFilterProps) {
    const selection = useGridStore((s) => s.filters.code3);
    const setCode3Filter = useGridStore((s) => s.setCode3Filter);
    const [recherche, setRecherche] = React.useState("");

    /** `null` = tout retenu : les cases sont alors toutes cochées. */
    const tout = selection === null;
    const selectionnes = React.useMemo(() => new Set(selection ?? []), [selection]);

    const visibles = React.useMemo(() => {
        const q = recherche.trim().toLowerCase();
        if (!q) return options;
        return options.filter((o) => `${o.code} ${o.label}`.toLowerCase().includes(q));
    }, [options, recherche]);

    const basculer = (code: string, coche: boolean) => {
        // Décocher depuis l'état « tout » doit retirer ce seul poste : on matérialise
        // donc la liste complète, sans quoi le premier décochage ne ferait rien.
        const base = tout ? options.map((o) => o.code) : (selection ?? []);
        const suivant = coche ? [...base, code] : base.filter((c) => c !== code);
        // Tout re-cocher revient à ne plus filtrer : on repasse à `null` pour que
        // l'état reste lisible (et l'URL propre).
        setCode3Filter(suivant.length === options.length ? null : suivant);
    };

    const libelle = tout
        ? "Toute la nomenclature"
        : selectionnes.size === 0
            ? "Aucune nomenclature"
            : selectionnes.size === 1
                ? (options.find((o) => o.code === selection![0])?.label ?? selection![0])
                : `${selectionnes.size} / ${options.length} nomenclatures`;

    return (
        <div className={cn("relative", className)}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="apple-input w-full min-w-[240px] flex items-center gap-2 text-left"
                        style={{ fontSize: "12px", height: "36px", paddingLeft: "12px", paddingRight: "12px" }}
                    >
                        <Filter className="h-3.5 w-3.5 opacity-40 shrink-0" />
                        <span className="flex-1 truncate" style={{ color: tout ? undefined : "var(--text-primary)" }}>
                            {libelle}
                        </span>
                        {!tout && (
                            <span
                                role="button"
                                tabIndex={0}
                                title="Tout réafficher"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setCode3Filter(null); }}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); setCode3Filter(null); } }}
                                className="shrink-0 rounded p-0.5 hover:bg-[var(--bg-elevated)]"
                            >
                                <X className="h-3.5 w-3.5 opacity-60" />
                            </span>
                        )}
                        <ChevronDown className="h-4 w-4 opacity-40 shrink-0" />
                    </button>
                </DropdownMenuTrigger>

                <DropdownMenuContent align="start" className="w-[320px] max-h-[420px] overflow-y-auto p-0">
                    <div className="sticky top-0 z-10 p-2 space-y-2" style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--border)" }}>
                        <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 opacity-40" />
                            <input
                                value={recherche}
                                onChange={(e) => setRecherche(e.target.value)}
                                onKeyDown={(e) => e.stopPropagation()}
                                placeholder="Filtrer les nomenclatures"
                                className="w-full rounded-lg pl-7 pr-2 py-1.5 text-[12px] outline-none"
                                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                            />
                        </div>
                        <div className="flex items-center gap-2 text-[11px]">
                            <button
                                type="button"
                                onClick={() => setCode3Filter(null)}
                                className="rounded px-2 py-1 hover:bg-[var(--bg-elevated)]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Tout cocher
                            </button>
                            <button
                                type="button"
                                // Un code vide ne correspond à aucune ligne : c'est ainsi qu'on
                                // exprime « rien de coché » sans confondre avec « pas de filtre ».
                                onClick={() => setCode3Filter([])}
                                className="rounded px-2 py-1 hover:bg-[var(--bg-elevated)]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Tout décocher
                            </button>
                            {recherche.trim() && visibles.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setCode3Filter(visibles.map((o) => o.code))}
                                    className="rounded px-2 py-1 hover:bg-[var(--bg-elevated)] ml-auto"
                                    style={{ color: "var(--accent)" }}
                                >
                                    Ne garder que ces {visibles.length}
                                </button>
                            )}
                        </div>
                    </div>

                    {visibles.length === 0 ? (
                        <p className="p-3 text-[12px]" style={{ color: "var(--text-muted)" }}>Aucune nomenclature ne correspond.</p>
                    ) : (
                        visibles.map((opt) => (
                            <DropdownMenuCheckboxItem
                                key={opt.code}
                                className="text-xs cursor-pointer"
                                checked={tout || selectionnes.has(opt.code)}
                                onCheckedChange={(v) => basculer(opt.code, !!v)}
                                onSelect={(e: Event) => e.preventDefault()}
                            >
                                <span className="font-mono opacity-60 mr-1.5">{opt.code}</span>
                                {opt.label}
                            </DropdownMenuCheckboxItem>
                        ))
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
