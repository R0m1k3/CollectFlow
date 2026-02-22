"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GammeCode, GridFilters, GridSummary, ProductRow } from "@/types/grid";

interface GridState {
    /** Source data from server */
    rows: ProductRow[];
    /** Draft edits: codein → new GammeCode */
    draftChanges: Record<string, GammeCode>;
    filters: GridFilters;
    summary: GridSummary;
    displayDensity: "compact" | "normal" | "comfortable";
    /** The active URL search parameters (e.g. ?fournisseur=123&magasin=TOTAL) */
    activeGridQuery: string;

    // Actions
    setRows: (rows: ProductRow[]) => void;
    setDraftGamme: (codein: string, gamme: GammeCode) => void;
    resetDrafts: () => void;
    /** Clear specific draft changes by codein */
    clearDrafts: (codeins: string[]) => void;
    setFilter: (key: keyof GridFilters, value: string | null) => void;
    setDisplayDensity: (density: "compact" | "normal" | "comfortable") => void;
    setActiveGridQuery: (query: string) => void;
    restoreSnapshot: (changes: Record<string, GammeCode>) => void;
}

function computeSummary(rows: ProductRow[], drafts: Record<string, GammeCode>): GridSummary {
    const active = rows.filter((r) => {
        const g = drafts[r.codein] ?? r.codeGamme;
        return g !== "Z";
    });
    const totalCa = active.reduce((s, r) => s + (r.totalCa ?? 0), 0);
    const totalMarge = active.reduce((s, r) => s + (r.totalMarge ?? 0), 0);
    return {
        totalRows: active.length,
        totalQuantite: active.reduce((s, r) => s + (r.totalQuantite ?? 0), 0),
        totalCa,
        totalMarge,
        tauxMargeGlobal: totalCa > 0 ? (totalMarge / totalCa) * 100 : 0,
    };
}

export const useGridStore = create<GridState>()(
    persist(
        (set, get) => ({
            rows: [],
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
                totalRows: 0,
                totalQuantite: 0,
                totalCa: 0,
                totalMarge: 0,
                tauxMargeGlobal: 0,
            },
            displayDensity: "normal",
            activeGridQuery: "",

            setRows: (rows) => {
                set({ rows, summary: computeSummary(rows, get().draftChanges) });
            },

            setDraftGamme: (codein, gamme) => {
                const { rows, draftChanges: oldDrafts } = get();
                const originalRow = rows.find(r => r.codein === codein);
                const originalGamme = originalRow?.codeGamme;

                const draftChanges = { ...oldDrafts };

                if (gamme === originalGamme) {
                    // If the new value matches initial, remove it from drafts
                    delete draftChanges[codein];
                } else {
                    // Otherwise, record the change
                    draftChanges[codein] = gamme;
                }

                set({ draftChanges, summary: computeSummary(rows, draftChanges) });
            },

            resetDrafts: () => {
                set({ draftChanges: {}, summary: computeSummary(get().rows, {}) });
            },
            clearDrafts: (codeins) => {
                const draftChanges = { ...get().draftChanges };
                codeins.forEach((id) => delete draftChanges[id]);
                set({ draftChanges, summary: computeSummary(get().rows, draftChanges) });
            },
            setFilter: (key, value) => {
                set((state) => ({ ...state, filters: { ...state.filters, [key]: value } }));
            },
            setDisplayDensity: (density) => set({ displayDensity: density }),
            setActiveGridQuery: (query) => set({ activeGridQuery: query }),
            restoreSnapshot: (changes) => {
                set({ draftChanges: changes, summary: computeSummary(get().rows, changes) });
            },
        }),
        {
            name: "collectflow-grid-storage",
            // Only persist filters, display density, drafts, and active grid query
            partialize: (state) => ({
                filters: state.filters,
                displayDensity: state.displayDensity,
                draftChanges: state.draftChanges,
                activeGridQuery: state.activeGridQuery,
            }),
        }
    )
);
