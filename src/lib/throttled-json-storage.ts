"use client";

import { createJSONStorage, type PersistStorage, type StorageValue } from "zustand/middleware";

/**
 * Stockage `persist` de zustand qui n'écrit dans le localStorage qu'au plus une
 * fois par `delaiMs`.
 *
 * `persist` réécrit (et resérialise) l'état à chaque `set`, quel que soit le
 * champ modifié : deux fois par changement de gamme, et à chaque mouvement de
 * souris pendant qu'on élargit une colonne. Ici, seule la dernière valeur est
 * écrite, et elle l'est aussitôt quand la page est quittée ou masquée.
 */
export function createThrottledJSONStorage<S>(delaiMs = 500): PersistStorage<S> | undefined {
    // Rendu serveur : même repli que zustand par défaut (rien n'est persisté).
    if (typeof window === "undefined") return undefined;
    const inner = createJSONStorage<S>(() => window.localStorage);
    if (!inner) return undefined;

    let enAttente: { name: string; value: StorageValue<S> } | null = null;
    let minuteur: number | null = null;

    const ecrire = () => {
        if (minuteur !== null) {
            clearTimeout(minuteur);
            minuteur = null;
        }
        if (!enAttente) return;
        const { name, value } = enAttente;
        enAttente = null;
        try {
            inner.setItem(name, value);
        } catch {
            /* quota dépassé ou stockage bloqué : ignoré, comme avant */
        }
    };

    window.addEventListener("pagehide", ecrire);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") ecrire();
    });

    return {
        getItem: (name) => (enAttente?.name === name ? enAttente.value : inner.getItem(name)),
        setItem: (name, value) => {
            enAttente = { name, value };
            if (minuteur === null) minuteur = window.setTimeout(ecrire, delaiMs);
        },
        removeItem: (name) => {
            if (enAttente?.name === name) enAttente = null;
            inner.removeItem(name);
        },
    };
}
