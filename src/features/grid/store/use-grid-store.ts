"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GammeCode, GridFilters, GridSummary, ProductRow } from "@/types/grid";

interface GridState {
    /** Source data from server */
    rows: ProductRow[];
    /** Fast lookup by codein; not persisted */
    rowsByCodein: Record<string, ProductRow>;
    /** Draft edits: codein → new GammeCode */
    draftChanges: Record<string, GammeCode>;
    filters: GridFilters;
    summary: GridSummary;
    displayDensity: "compact" | "normal" | "comfortable";
    /** The active URL search parameters (e.g. ?fournisseur=123&magasin=TOTAL) */
    activeGridQuery: string;
    /** Persisted column visibility state */
    columnVisibility: Record<string, boolean>;
    /** Persisted column sizing state */
    columnSizing: Record<string, number>;

    /** Currently displayed store: "TOTAL" | "292" | "579" */
    activeMagasin: string;
    setActiveMagasin: (code: string) => void;

    // Actions
    setRows: (rows: ProductRow[]) => void;
    setDraftGamme: (codein: string, gamme: GammeCode) => void;
    resetDrafts: () => void;
    /** Clear specific draft changes by codein */
    clearDrafts: (codeins: string[]) => void;
    /** Apply saved drafts onto row.codeGamme so change indicators persist after save */
    applyDraftsToRows: (draftsToApply: Record<string, GammeCode>) => void;
    setFilter: (key: Exclude<keyof GridFilters, "code3">, value: string | null) => void;
    /** Nomenclatures retenues. `null` = aucun filtre, `[]` = rien de coché. */
    setCode3Filter: (codes: string[] | null) => void;
    setDisplayDensity: (density: "compact" | "normal" | "comfortable") => void;
    setActiveGridQuery: (query: string) => void;
    restoreSnapshot: (changes: Record<string, GammeCode>) => void;
    batchSetDraftGamme: (changes: Record<string, GammeCode>) => void;
    setColumnVisibility: (updater: Record<string, boolean> | ((old: Record<string, boolean>) => Record<string, boolean>)) => void;
    setColumnSizing: (updater: Record<string, number> | ((old: Record<string, number>) => Record<string, number>)) => void;
}

let summaryTimer: ReturnType<typeof setTimeout> | null = null;

function indexRows(rows: ProductRow[]): Record<string, ProductRow> {
    const indexed: Record<string, ProductRow> = {};
    for (const row of rows) indexed[row.codein] = row;
    return indexed;
}

function computeSummary(rows: ProductRow[], drafts: Record<string, GammeCode>, magasin = "TOTAL"): GridSummary {
    const active = rows.filter((r) => {
        const g = drafts[r.codein] ?? r.codeGamme;
        return g !== "Z";
    });
    const getCa    = (r: ProductRow) => magasin === "TOTAL" ? (r.totalCa     ?? 0) : (r.caByStore?.[magasin]       ?? 0);
    const getQte   = (r: ProductRow) => magasin === "TOTAL" ? (r.totalQuantite ?? 0) : (r.quantiteByStore?.[magasin] ?? 0);
    const getMarge = (r: ProductRow) => magasin === "TOTAL" ? (r.totalMarge  ?? 0) : (r.margeByStore?.[magasin]    ?? 0);
    const totalCa    = active.reduce((s, r) => s + getCa(r),    0);
    const totalMarge = active.reduce((s, r) => s + getMarge(r), 0);
    return {
        totalProducts: rows.length,
        totalRows: active.length,
        totalQuantite: active.reduce((s, r) => s + getQte(r), 0),
        totalCa,
        totalMarge,
        tauxMargeGlobal: totalCa > 0 ? (totalMarge / totalCa) * 100 : 0,
    };
}

/** Sous-ensemble réellement écrit dans le navigateur (cf. `partialize`). */
type GridPersisted = Pick<
    GridState,
    "filters" | "displayDensity" | "draftChanges" | "activeGridQuery" | "columnVisibility" | "columnSizing"
>;

export const useGridStore = create<GridState>()(
    persist(
        (set, get) => ({
            rows: [],
            rowsByCodein: {},
            activeMagasin: "TOTAL",
            draftChanges: {},
            filters: {
                magasin: null,
                codeFournisseur: null,
                code1: null,
                code2: null,
                code3: null,
                codeGamme: null,
                search: "",
            },
            summary: {
                totalProducts: 0,
                totalRows: 0,
                totalQuantite: 0,
                totalCa: 0,
                totalMarge: 0,
                tauxMargeGlobal: 0,
            },
            displayDensity: "normal",
            activeGridQuery: "",
            columnVisibility: {},
            columnSizing: {},

            setActiveMagasin: (code) => {
                set({ activeMagasin: code });
                if (summaryTimer) clearTimeout(summaryTimer);
                summaryTimer = setTimeout(() => {
                    const state = get();
                    set({ summary: computeSummary(state.rows, state.draftChanges, state.activeMagasin) });
                }, 80);
            },

            setRows: (rows) => {
                set({ rows, rowsByCodein: indexRows(rows) });
                if (summaryTimer) clearTimeout(summaryTimer);
                summaryTimer = setTimeout(() => {
                    const state = get();
                    set({ summary: computeSummary(state.rows, state.draftChanges, state.activeMagasin) });
                }, 120);
            },

            setDraftGamme: (codein, gamme) => {
                const { rowsByCodein, draftChanges: oldDrafts } = get();
                const originalRow = rowsByCodein[codein];
                const originalGamme = originalRow?.codeGamme;

                const draftChanges = { ...oldDrafts };

                if (gamme === originalGamme) {
                    // If the new value matches initial, remove it from drafts
                    delete draftChanges[codein];
                } else {
                    // Otherwise, record the change
                    draftChanges[codein] = gamme;
                }

                set({ draftChanges });
                if (summaryTimer) clearTimeout(summaryTimer);
                summaryTimer = setTimeout(() => {
                    const state = get();
                    set({ summary: computeSummary(state.rows, state.draftChanges, state.activeMagasin) });
                }, 80);
            },

            resetDrafts: () => {
                set({ draftChanges: {} });
                if (summaryTimer) clearTimeout(summaryTimer);
                summaryTimer = setTimeout(() => {
                    const state = get();
                    set({ summary: computeSummary(state.rows, {}, state.activeMagasin) });
                }, 80);
            },
            clearDrafts: (codeins) => {
                const draftChanges = { ...get().draftChanges };
                codeins.forEach((id) => delete draftChanges[id]);
                set({ draftChanges });
                if (summaryTimer) clearTimeout(summaryTimer);
                summaryTimer = setTimeout(() => {
                    const state = get();
                    set({ summary: computeSummary(state.rows, state.draftChanges, state.activeMagasin) });
                }, 80);
            },
            /** Apply saved drafts onto row.codeGamme so isModified works after clearing drafts */
            applyDraftsToRows: (draftsToApply: Record<string, GammeCode>) => {
                const rows = get().rows.map(r => {
                    const newGamme = draftsToApply[r.codein];
                    if (newGamme !== undefined) {
                        return { ...r, codeGamme: newGamme };
                    }
                    return r;
                });
                set({ rows, rowsByCodein: indexRows(rows), summary: computeSummary(rows, get().draftChanges, get().activeMagasin) });
            },
            setFilter: (key, value) => {
                set((state) => ({ ...state, filters: { ...state.filters, [key]: value } }));
            },
            setCode3Filter: (codes) => {
                set((state) => ({ ...state, filters: { ...state.filters, code3: codes } }));
            },
            setDisplayDensity: (density) => set({ displayDensity: density }),
            setActiveGridQuery: (query) => set({ activeGridQuery: query }),
            restoreSnapshot: (changes) => {
                set({ draftChanges: changes, summary: computeSummary(get().rows, changes, get().activeMagasin) });
            },

            batchSetDraftGamme: (newChanges) => {
                const { rows, rowsByCodein, draftChanges: oldDrafts } = get();
                const updatedDrafts = { ...oldDrafts };

                Object.entries(newChanges).forEach(([codein, gamme]) => {
                    const originalRow = rowsByCodein[codein];
                    const originalGamme = originalRow?.codeGamme;

                    if (gamme === originalGamme) {
                        delete updatedDrafts[codein];
                    } else {
                        updatedDrafts[codein] = gamme;
                    }
                });

                set({ draftChanges: updatedDrafts });
                if (summaryTimer) clearTimeout(summaryTimer);
                summaryTimer = setTimeout(() => {
                    const state = get();
                    set({ summary: computeSummary(rows, state.draftChanges, state.activeMagasin) });
                }, 80);
            },

            setColumnVisibility: (updater) => {
                set((state) => ({
                    columnVisibility: typeof updater === 'function' ? updater(state.columnVisibility) : updater
                }));
            },
            setColumnSizing: (updater) => {
                set((state) => ({
                    columnSizing: typeof updater === 'function' ? updater(state.columnSizing) : updater
                }));
            },
        }),
        {
            name: "collectflow-grid-storage",
            /**
             * v1 — `filters.code3` est passé d'une chaîne unique à `string[] | null`
             * (filtre multi-nomenclatures). Sans migration, la valeur déjà présente
             * dans le navigateur restait une chaîne : `new Set("320211")` produit un
             * ensemble de caractères, plus aucune ligne ne correspond, et la Grille
             * apparaît vide. Le numéro de version force la reprise de l'existant.
             */
            version: 1,
            migrate: (persisted: unknown, version: number): GridPersisted => {
                const etat = (persisted ?? {}) as GridPersisted & { filters?: Record<string, unknown> };
                if (version < 1 && etat.filters) {
                    const c = etat.filters.code3;
                    etat.filters.code3 = typeof c === "string" && c !== "" ? [c] : Array.isArray(c) ? c : null;
                }
                return etat;
            },
            // Only persist filters, display density, drafts, active grid query, and column visibility/sizing
            partialize: (state): GridPersisted => ({
                filters: state.filters,
                displayDensity: state.displayDensity,
                draftChanges: state.draftChanges,
                activeGridQuery: state.activeGridQuery,
                columnVisibility: state.columnVisibility,
                columnSizing: state.columnSizing,
            }),
        }
    )
);
