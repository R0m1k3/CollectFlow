"use client";

import { useEffect } from "react";
import { rowsKeyFor, useGridStore } from "@/features/grid/store/use-grid-store";
import { CODE_TOUS_MAGASINS } from "@/lib/magasins";
import type { StorePatch } from "@/features/grid/lib/store-patch";

/**
 * Demande le complément de l'API FF du magasin affiché, une fois les lignes
 * chargées, et l'applique à son arrivée. Une seule demande par magasin et par
 * chargement : revenir sur un magasin déjà complété ne coûte rien.
 */
export function useStorePatch(codeFournisseur: string, enabled: boolean) {
    const activeMagasin = useGridStore((s) => s.activeMagasin);
    const rowsMeta = useGridStore((s) => s.rowsMeta);
    const applyStorePatch = useGridStore((s) => s.applyStorePatch);

    useEffect(() => {
        if (!enabled || activeMagasin === CODE_TOUS_MAGASINS || !rowsMeta) return;
        if (rowsMeta.key !== rowsKeyFor(codeFournisseur) || rowsMeta.patchedStores.includes(activeMagasin)) return;

        const controller = new AbortController();
        const gen = { key: rowsMeta.key, loadedAt: rowsMeta.loadedAt };
        const params = new URLSearchParams({ fournisseur: codeFournisseur, magasin: activeMagasin });
        fetch(`/api/grid/rows/store-patch?${params}`, { signal: controller.signal, cache: "no-store" })
            .then((res) => (res.ok ? (res.json() as Promise<StorePatch>) : null))
            .then((patch) => {
                if (patch && !controller.signal.aborted) applyStorePatch(gen, patch);
            })
            // Échec ou abandon : les chiffres SQL restent affichés, et la demande
            // repartira au prochain passage sur ce magasin.
            .catch(() => {});
        return () => controller.abort();
    }, [enabled, codeFournisseur, activeMagasin, rowsMeta, applyStorePatch]);
}
