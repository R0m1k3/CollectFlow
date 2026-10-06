"use client";

import { useCallback } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { saveDraftChanges } from "@/features/grid/api/save-draft-changes";
import { GammeCode } from "@/types/grid";

/** Modifications portant sur les lignes chargées (le fournisseur affiché). */
function modificationsActives(draftChanges: Record<string, GammeCode>, rowsByCodein: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(draftChanges).filter(([codein]) => rowsByCodein[codein]));
}

/**
 * Enregistre les gammes modifiées du fournisseur affiché (server action).
 *
 * Le composant ne s'abonne qu'au NOMBRE de modifications : l'abonnement aux
 * modifications elles-mêmes le redessinait à chaque changement de gamme. Le
 * détail est lu au moment d'enregistrer.
 */
export function useSaveDrafts(magasin: string) {
    const count = useGridStore((s) => {
        let n = 0;
        for (const codein in s.draftChanges) if (s.rowsByCodein[codein]) n++;
        return n;
    });
    /** Propositions de l'API en attente sur les lignes chargées. */
    const nbAValider = useGridStore((s) => {
        let n = 0;
        for (const codein in s.gammesAValider) if (s.rowsByCodein[codein]) n++;
        return n;
    });

    const save = useCallback(async () => {
        const { draftChanges, rowsByCodein, rows, gammesAValider, applyDraftsToRows, clearDrafts, retirerGammesAValider } = useGridStore.getState();
        const activeDrafts = modificationsActives(draftChanges, rowsByCodein);
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
        // Propositions de l'API examinées : enregistrées si elles sont restées en
        // modification, écartées sinon. Dans les deux cas, elles sont traitées.
        const gammesAValiderTraitees = Object.keys(gammesAValider).filter((codein) => rowsByCodein[codein]);

        if (changes.length === 0 && gammesAValiderTraitees.length === 0) return { success: true, saved: 0 };

        // Fournisseur déduit de la première ligne modifiée
        const firstRow = rowsByCodein[changes[0]?.codein ?? gammesAValiderTraitees[0]] ?? rows[0];
        const codeFournisseur = firstRow?.codeFournisseur ?? "";
        const nomFournisseur = firstRow?.nomFournisseur ?? "";

        const result = await saveDraftChanges({ codeFournisseur, nomFournisseur, magasin, changes, gammesAValiderTraitees });

        if (result.success) {
            // Report des valeurs enregistrées sur row.codeGamme AVANT de vider les
            // modifications, pour que l'indicateur « modifié » (codeGamme !==
            // codeGammeInit) reste juste.
            applyDraftsToRows(activeDrafts);
            clearDrafts(Object.keys(activeDrafts));
            retirerGammesAValider(gammesAValiderTraitees);
        }
        return result;
    }, [magasin]);

    return { save, hasDrafts: count > 0 || nbAValider > 0, count, nbAValider };
}
