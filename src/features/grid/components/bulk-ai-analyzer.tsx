"use client";

import React, { useState } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { ProductRow } from "@/types/grid";

export function BulkAiAnalyzer() {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, message: "" });
    const setDraftGamme = useGridStore(state => state.setDraftGamme);
    const setInsight = useAiCopilotStore(state => state.setInsight);

    const handleAnalyze = async () => {
        const { rows } = useGridStore.getState();
        if (rows.length === 0) return;

        setIsAnalyzing(true);

        try {
            // Group by Nomenclature (libelle3 or a fallback)
            const groups: Record<string, ProductRow[]> = {};
            rows.forEach(r => {
                const rayon = r.libelle3 || "Non classifié";
                if (!groups[rayon]) groups[rayon] = [];
                groups[rayon].push(r);
            });

            // Create chunks of up to 50 products per rayon
            const CHUNK_SIZE = 50;
            const chunks: { rayon: string; items: ProductRow[] }[] = [];

            for (const [rayon, items] of Object.entries(groups)) {
                for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                    chunks.push({
                        rayon,
                        items: items.slice(i, i + CHUNK_SIZE)
                    });
                }
            }

            setProgress({ current: 0, total: chunks.length, message: "Initialisation..." });

            // Process sequentially
            let completed = 0;
            for (const chunk of chunks) {
                setProgress({ current: completed, total: chunks.length, message: `Analyse du rayon: ${chunk.rayon}` });

                // Simplify payload to save tokens
                const payloadProducts = chunk.items.map(r => ({
                    codein: r.codein,
                    gtin: r.gtin,
                    nom: r.libelle1,
                    ventes: r.totalQuantite,
                    marge: r.totalMarge ? parseFloat(((r.totalMarge / (r.totalCa || 1)) * 100).toFixed(1)) : 0,
                }));

                const res = await fetch("/api/ai/batch-analyze", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        rayon: chunk.rayon,
                        products: payloadProducts
                    })
                });

                if (!res.ok) {
                    console.error(`Erreur sur le lot ${chunk.rayon}`);
                    completed++;
                    continue; // Skip the failed chunk but continue processing
                }

                try {
                    const data = await res.json();

                    // data.results should be an array
                    if (data && Array.isArray(data.results)) {
                        data.results.forEach((reco: any) => {
                            if (reco.codein && reco.recommandationGamme) {
                                // Update the gamme draft
                                setDraftGamme(reco.codein, reco.recommandationGamme);
                                // Inject the justification into the AI insight column
                                const justification = reco.justificationCourte || `Recommandation: Gamme ${reco.recommandationGamme}`;
                                setInsight(reco.codein, justification, reco.isDuplicate ?? false);
                            }
                        });
                    }
                } catch (e) {
                    console.error("Failed to parse JSON for chunk", chunk.rayon, e);
                }

                completed++;
            }

            setProgress({ current: completed, total: chunks.length, message: "Analyse terminée avec succès !" });
            setTimeout(() => {
                setIsAnalyzing(false);
            }, 3000);

        } catch (error) {
            console.error("Erreur globale lors de l'analyse:", error);
            alert("Une erreur inattendue s'est produite pendant l'analyse globale.");
            setIsAnalyzing(false);
        }
    };

    if (isAnalyzing) {
        return (
            <div className="flex items-center gap-3 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800">
                <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
                <div className="flex flex-col">
                    <span className="text-xs font-bold text-indigo-700 dark:text-indigo-400">
                        {progress.message}
                    </span>
                    <div className="w-full bg-indigo-200 dark:bg-indigo-800/50 rounded-full h-1.5 mt-1.5">
                        <div
                            className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${Math.max(5, (progress.current / progress.total) * 100)}%` }}
                        ></div>
                    </div>
                </div>
            </div>
        );
    }

    if (progress.current === progress.total && progress.total > 0 && !isAnalyzing) {
        return (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 cursor-default">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                    Analyse terminée ({progress.total} lots analysés)
                </span>
            </div>
        );
    }

    return (
        <button
            onClick={handleAnalyze}
            className="group flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm bg-gradient-to-r from-indigo-500 to-violet-500 text-white hover:shadow-md hover:brightness-110 active:scale-95 border border-indigo-400"
        >
            <Sparkles className="w-4 h-4" />
            Analyse IA Globale
        </button>
    );
}
