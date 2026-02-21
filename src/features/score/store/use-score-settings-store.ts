"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_SCORE_SETTINGS, type ScoreSettings } from "@/lib/score-engine";

interface ScoreSettingsState extends ScoreSettings {
    setSeuilAxeFort: (v: number) => void;
    setBonusParAxe: (v: number) => void;
    resetDefaults: () => void;
}

export const useScoreSettingsStore = create<ScoreSettingsState>()(
    persist(
        (set) => ({
            ...DEFAULT_SCORE_SETTINGS,

            setSeuilAxeFort: (v) => set({ seuilAxeFort: v }),
            setBonusParAxe: (v) => set({ bonusParAxe: v }),
            resetDefaults: () => set({ ...DEFAULT_SCORE_SETTINGS }),
        }),
        {
            name: "collectflow-score-settings",
        }
    )
);
