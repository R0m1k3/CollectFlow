"use client";

import { create } from "zustand";

interface AiInsight {
    codein: string;
    insight: string;
    status: "idle" | "loading" | "done" | "error";
    isDuplicate?: boolean;
}

interface AiCopilotState {
    insights: Record<string, AiInsight>;
    setInsight: (codein: string, insight: string, isDuplicate?: boolean) => void;
    analyzeProduct: (payload: {
        codein: string;
        libelle1: string;
        totalCa: number;
        tauxMarge: number;
        totalQuantite: number;
        sales12m: Record<string, number>;
        codeGamme: string | null;
    }) => Promise<void>;
}

export const useAiCopilotStore = create<AiCopilotState>((set) => ({
    insights: {},

    setInsight: (codein, insight, isDuplicate = false) => {
        set((s) => ({
            insights: {
                ...s.insights,
                [codein]: { codein, insight, status: "done", isDuplicate },
            },
        }));
    },

    analyzeProduct: async (payload) => {
        const { codein } = payload;

        // Mark as loading
        set((s) => ({
            insights: { ...s.insights, [codein]: { codein, insight: "", status: "loading" } },
        }));

        try {
            const res = await fetch("/api/ai/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            set((s) => ({
                insights: {
                    ...s.insights,
                    [codein]: { codein, insight: data.insight, status: "done" },
                },
            }));
        } catch {
            set((s) => ({
                insights: {
                    ...s.insights,
                    [codein]: { codein, insight: "Erreur lors de l'analyse.", status: "error" },
                },
            }));
        }
    },
}));
