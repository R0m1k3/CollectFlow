"use client";

import { useCallback } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { saveDraftChanges } from "@/features/grid/api/save-draft-changes";
import { GammeCode } from "@/types/grid";

/**
 * Builds the payload from Zustand draftChanges and calls the Server Action.
 * Filters changes to only include those in the provided codeins list (e.g. current supplier).
 */
export function useSaveDrafts(magasin: string, filterCodeins?: string[]) {
    const { draftChanges, resetDrafts, clearDrafts } = useGridStore();

    // Only consider changes that are in the filter list (if provided)
    const activeDrafts = filterCodeins
        ? Object.fromEntries(Object.entries(draftChanges).filter(([codein]) => filterCodeins.includes(codein)))
        : draftChanges;

    const count = Object.keys(activeDrafts).length;

    const save = useCallback(async () => {
        const changes = Object.entries(activeDrafts).map(([codein, codeGamme]) => ({
            codein,
            magasin,
            codeGamme: codeGamme as GammeCode,
        }));

        if (changes.length === 0) return { success: true, saved: 0 };

        const result = await saveDraftChanges({ changes });

        if (result.success) {
            if (filterCodeins) {
                // Clear ONLY the ones we just saved
                clearDrafts(Object.keys(activeDrafts));
            } else {
                resetDrafts();
            }
        }
        return result;
    }, [activeDrafts, magasin, resetDrafts, clearDrafts, filterCodeins]);

    return { save, hasDrafts: count > 0, count };
}
