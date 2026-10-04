"use client";

import { useCallback, useMemo } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { saveDraftChanges } from "@/features/grid/api/save-draft-changes";
import { GammeCode } from "@/types/grid";

/**
 * Builds the payload from Zustand draftChanges and calls the Server Action.
 * Filters changes to only include those in the provided codeins list (e.g. current supplier).
 */
export function useSaveDrafts(magasin: string, filterCodeins?: string[]) {
    const draftChanges = useGridStore((s) => s.draftChanges);
    const rowsByCodein = useGridStore((s) => s.rowsByCodein);
    const resetDrafts = useGridStore((s) => s.resetDrafts);
    const clearDrafts = useGridStore((s) => s.clearDrafts);
    const applyDraftsToRows = useGridStore((s) => s.applyDraftsToRows);

    // Only consider changes that are in the filter list (if provided)
    const filterCodeinSet = useMemo(
        () => filterCodeins ? new Set(filterCodeins) : null,
        [filterCodeins]
    );
    const activeDrafts = useMemo(
        () => filterCodeinSet
            ? Object.fromEntries(Object.entries(draftChanges).filter(([codein]) => filterCodeinSet.has(codein)))
            : draftChanges,
        [draftChanges, filterCodeinSet]
    );

    const count = Object.keys(activeDrafts).length;

    const save = useCallback(async () => {
        // Index par code article : `rows.find` dans la boucle coûtait
        // (modifications × lignes) comparaisons sur un gros fournisseur.
        const changes = Object.entries(activeDrafts).map(([codein, codeGamme]) => {
            const row = rowsByCodein[codein];
            return {
                codein,
                codeGammeBefore: row?.codeGammeInit ?? row?.codeGamme ?? null,
                codeGamme: codeGamme as GammeCode,
            };
        });

        if (changes.length === 0) return { success: true, saved: 0 };

        // Derive supplier info from the first matching row
        const firstRow = changes.length > 0 ? rowsByCodein[changes[0].codein] : undefined;
        const codeFournisseur = firstRow?.codeFournisseur ?? "";
        const nomFournisseur = firstRow?.nomFournisseur ?? "";

        const result = await saveDraftChanges({ codeFournisseur, nomFournisseur, magasin, changes });

        if (result.success) {
            // Apply saved values onto row.codeGamme BEFORE clearing drafts
            // so that isModified (codeGamme !== codeGammeInit) stays true
            applyDraftsToRows(activeDrafts);
            if (filterCodeins) {
                clearDrafts(Object.keys(activeDrafts));
            } else {
                resetDrafts();
            }
        }
        return result;
    }, [activeDrafts, rowsByCodein, magasin, resetDrafts, clearDrafts, applyDraftsToRows, filterCodeins]);

    return { save, hasDrafts: count > 0, count };
}
