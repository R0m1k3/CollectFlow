"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Score Settings Store — v4 (simplifié)
 *
 * Le score hybride v4 utilise des paliers absolus (Volume 50pts + CA 30pts + Marge 20pts + Bonus ±10pts).
 * Il n'y a plus de pondérations configurables par l'utilisateur.
 * Ce store est conservé pour la compatibilité mais n'a plus de paramètres ajustables.
 */

interface ScoreSettingsState {
    _version: number;
}

export const useScoreSettingsStore = create<ScoreSettingsState>()(
    persist(
        () => ({
            _version: 4,
        }),
        {
            name: "collectflow-score-settings",
        }
    )
);
