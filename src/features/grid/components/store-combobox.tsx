"use client";

import { useMemo } from "react";
import { Segmented } from "@/components/ui/tabs";
import { CODE_TOUS_MAGASINS, LIBELLE_TOUS_MAGASINS, nomMagasin } from "@/lib/magasins";

interface Store {
    code: string;
    nom: string;
}

interface StoreComboboxProps {
    magasins: Store[];
    selectedCode: string | null;
    onSelect: (code: string) => void;
    className?: string;
}

/**
 * Choix du magasin affiché dans la Grille : trois boutons visibles d'un coup
 * d'œil (nos 2 magasins, puis chacun), au lieu d'une liste avec recherche pour
 * deux magasins qui affichait « TOTAL » et des identifiants techniques.
 */
export function StoreCombobox({ magasins, selectedCode, onSelect, className }: StoreComboboxProps) {
    const items = useMemo(
        () => [
            { value: CODE_TOUS_MAGASINS, label: LIBELLE_TOUS_MAGASINS },
            ...magasins.map((m) => ({ value: m.code, label: nomMagasin(m.code) })),
        ],
        [magasins],
    );
    return (
        <Segmented
            items={items}
            value={selectedCode || CODE_TOUS_MAGASINS}
            onChange={onSelect}
            className={className}
        />
    );
}
