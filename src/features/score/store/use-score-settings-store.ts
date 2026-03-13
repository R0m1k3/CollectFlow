"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_SCORE_SETTINGS, type ScoreSettings } from "@/lib/score-engine";

interface ScoreSettingsState extends ScoreSettings {
    setWeightCA: (v: number) => void;
    setWeightVolume: (v: number) => void;
    setWeightMarge: (v: number) => void;
    resetDefaults: () => void;
}

export const useScoreSettingsStore = create<ScoreSettingsState>()(
    persist(
        (set) => ({
            ...DEFAULT_SCORE_SETTINGS,

            setWeightCA: (v) => set({ weightCA: v }),
            setWeightVolume: (v) => set({ weightVolume: v }),
            setWeightMarge: (v) => set({ weightMarge: v }),
            resetDefaults: () => set({ ...DEFAULT_SCORE_SETTINGS }),
        }),
        {
            name: "collectflow-score-settings",
        }
    )
);
