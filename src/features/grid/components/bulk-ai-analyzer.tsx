"use client";

import React, { useState } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";

export function BulkAiAnalyzer() {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, message: "", errors: 0 });
    const setDraftGamme = useGridStore(state => state.setDraftGamme);
    const setInsight = useAiCopilotStore(state => state.setInsight);

    const handleAnalyze = async () => {
        const { rows } = useGridStore.getState();

        console.log("[BulkAiAnalyzer] Starting analysis on", rows.length, "rows");

        // Payload identique à l'analyse individuelle — aucun enrichissement
        const productPayloads = rows.map(r => ({
            codein: r.codein,
            libelle1: r.libelle1 || "",
            totalCa: r.totalCa || 0,
            tauxMarge: r.tauxMarge || 0,
            totalQuantite: r.totalQuantite || 0,
            sales12m: r.sales12m || {},
            codeGamme: r.codeGamme || null,
            score: r.score || 0,
        }));

        setIsAnalyzing(true);
        let completed = 0;
        let errors = 0;

        setProgress({ current: 0, total: productPayloads.length, message: "Initialisation...", errors: 0 });

        try {
            const CONCURRENCY = 5;
            const remaining = [...productPayloads];

            const processNext = async () => {
                const payload = remaining.shift();
                if (!payload) return;

                try {
                    let res: Response | null = null;
                    const MAX_RETRIES = 3;

                    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                        res = await fetch("/api/ai/analyze", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload)
                        });

                        if (res.status === 429 && attempt < MAX_RETRIES) {
                            const errData = await res.json().catch(() => ({}));
                            const waitSecs = errData.retryAfter ?? (15 * attempt);
                            for (let t = waitSecs; t > 0; t--) {
                                setProgress(prev => ({ ...prev, message: `⏳ ${completed}/${productPayloads.length} — Limite API, reprise dans ${t}s...` }));
                                await new Promise(r => setTimeout(r, 1000));
                            }
                            continue;
                        }
                        break;
                    }

                    if (!res || !res.ok) {
                        errors++;
                    } else {
                        const data = await res.json();
                        if (data.insight) {
                            // Extraire la recommandation (première lettre A, C ou Z)
                            const match = data.insight.match(/^[^A-Z]*([ACZ])\b/i);
                            const gamme = match ? match[1].toUpperCase() : null;

                            if (gamme) {
                                setDraftGamme(data.codein, gamme);
                                setInsight(data.codein, data.insight, false);
                            }
                        }
                    }
                } catch {
                    errors++;
                } finally {
                    completed++;
                    setProgress({
                        current: completed,
                        total: productPayloads.length,
                        message: completed === productPayloads.length
                            ? "Analyse terminée"
                            : `Analyse: ${completed}/${productPayloads.length} produits`,
                        errors,
                    });
                    await processNext();
                }
            };

            const workers = Array.from(
                { length: Math.min(CONCURRENCY, productPayloads.length) },
                () => processNext()
            );
            await Promise.all(workers);

            setProgress(prev => ({
                ...prev,
                current: completed,
                total: productPayloads.length,
                message: `Analyse terminée ! (${errors > 0 ? errors + " erreurs" : "succès"})`,
            }));
            setTimeout(() => setIsAnalyzing(false), 3000);

        } catch (error) {
            console.error("Erreur globale lors de l'analyse:", error);
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
                    Analyse terminée ({progress.total} produits analysés)
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
