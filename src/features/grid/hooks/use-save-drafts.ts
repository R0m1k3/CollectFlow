"use client";

import { useCallback } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { saveDraftChanges } from "@/features/grid/api/save-draft-changes";
import { GammeCode } from "@/types/grid";

/**
 * Builds the payload from Zustand draftChanges and calls the Server Action.
 * Returns a cleanup function called after successful save.
 */
export function useSaveDrafts(magasin: string) {
    const { draftChanges, resetDrafts } = useGridStore();

    const save = useCallback(async () => {
        const changes = Object.entries(draftChanges).map(([codein, codeGamme]) => ({
            codein,
            magasin,
            codeGamme: codeGamme as GammeCode,
        }));

        if (changes.length === 0) return { success: true, saved: 0 };

        const result = await saveDraftChanges({ changes });
        if (result.success) resetDrafts();
        return result;
    }, [draftChanges, magasin, resetDrafts]);

    return { save, hasDrafts: Object.keys(draftChanges).length > 0, count: Object.keys(draftChanges).length };
}
