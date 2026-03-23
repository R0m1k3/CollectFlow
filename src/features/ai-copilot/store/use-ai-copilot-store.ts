"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AiInsight {
    codein: string;
    insight: string;
    status: "idle" | "loading" | "done" | "error";
    isDuplicate?: boolean;
}

interface AiCopilotState {
    insights: Record<string, AiInsight>;
    setInsight: (codein: string, insight: string, isDuplicate?: boolean) => void;
    batchSetInsights: (entries: { codein: string; insight: string }[]) => void;
    setLoading: (codein: string) => void;
    batchSetLoading: (codeins: string[]) => void;
    setError: (codein: string, error: string) => void;
    analyzeProduct: (payload: {
        codein: string;
        noid?: number;
        libelle1: string;
        libelleNiveau2?: string;
        totalCa: number;
        tauxMarge: number;
        totalQuantite: number;
        storeCount: number;
        sales12m: Record<string, number>;
        codeGamme: string | null;
        score?: number | null;
        regularityScore?: number;
        lastMonthWithSale?: string;
        inactivityMonths?: number;
        weightedTotalQuantite?: number;
        weightedTotalCa?: number;
        avgQtyFournisseur?: number;
        avgQtyRayon?: number;
        shareCa?: number;
        shareMarge?: number;
        shareQty?: number;
        totalFournisseurCa?: number;
        codeFournisseur?: string;
        totalMagasins?: number;
        prixVente?: number;
        unitsPerStorePerMonth?: number;
        caPerStorePerYear?: number;
        stockActuel?: number;
        stockTotal?: number;
        pcb?: number;
        commandesEnCours?: number;
        nbJoursDerniereVente?: number;
        derniereVente?: string;
        supplierContext?: string;
        scoring?: {
            score: number;
            verdict: "A" | "Z";
            isRecent: boolean;
            isLastProduct: boolean;
            isTop30Supplier: boolean;
        };
    }) => Promise<void>;
    resetInsights: () => void;
}

export const useAiCopilotStore = create<AiCopilotState>()(
    persist(
        (set, get) => ({
            insights: {},

            setInsight: (codein, insight, isDuplicate = false) => {
                set((s) => ({
                    insights: {
                        ...s.insights,
                        [codein]: { codein, insight, status: "done", isDuplicate },
                    },
                }));
            },

            batchSetInsights: (entries) => {
                set((s) => {
                    const nextInsights = { ...s.insights };
                    entries.forEach(({ codein, insight }) => {
                        nextInsights[codein] = { codein, insight, status: "done" };
                    });
                    return { insights: nextInsights };
                });
            },

            setLoading: (codein) => {
                set((s) => ({
                    insights: {
                        ...s.insights,
                        [codein]: { codein, insight: "", status: "loading" },
                    },
                }));
            },

            batchSetLoading: (codeins) => {
                set((s) => {
                    const nextInsights = { ...s.insights };
                    codeins.forEach(codein => {
                        nextInsights[codein] = { codein, insight: "", status: "loading" };
                    });
                    return { insights: nextInsights };
                });
            },

            setError: (codein, error) => {
                set((s) => ({
                    insights: {
                        ...s.insights,
                        [codein]: { codein, insight: error, status: "error" },
                    },
                }));
            },

            resetInsights: () => {
                set({ insights: {} });
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
        }),
        {
            name: "collectflow-ai-storage",
        }
    )
);
