"use client";

import React, { useState, useRef } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import { Sparkles, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { ProductAnalysisInput, AnalysisResult } from "@/features/ai-copilot/models/ai-analysis.types";

export function BulkAiAnalyzer() {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, message: "", errors: 0 });
    const isCancelledRef = useRef(false);

    const setDraftGamme = useGridStore(state => state.setDraftGamme);
    const setInsight = useAiCopilotStore(state => state.setInsight);

    const handleStop = () => {
        isCancelledRef.current = true;
        setProgress(prev => ({ ...prev, message: "Arrêt en cours..." }));
    };

    const handleAnalyze = async () => {
        const { rows } = useGridStore.getState();
        isCancelledRef.current = false;

        const totalQtySum = rows.reduce((sum: number, r: any) => sum + (r.totalQuantite || 0), 0);
        const avgQty = rows.length > 0 ? totalQtySum / rows.length : 0;

        // Benchmarks par groupe de magasins
        const rowsGroup1 = rows.filter(r => (r.workingStores?.length || 1) === 1);
        const rowsGroup2 = rows.filter(r => (r.workingStores?.length || 1) >= 2);

        const avgQty1 = rowsGroup1.length > 0 ? rowsGroup1.reduce((s: number, r: any) => s + (r.totalQuantite || 0), 0) / rowsGroup1.length : 0;
        const avgQty2 = rowsGroup2.length > 0 ? rowsGroup2.reduce((s: number, r: any) => s + (r.totalQuantite || 0), 0) / rowsGroup2.length : 0;

        const productPayloads: ProductAnalysisInput[] = rows.map(r => ({
            codein: r.codein,
            libelle1: r.libelle1 || "",
            totalCa: r.totalCa || 0,
            tauxMarge: r.tauxMarge || 0,
            totalQuantite: r.totalQuantite || 0,
            avgTotalQuantite: avgQty,
            avgQtyGroup1: avgQty1,
            avgQtyGroup2: avgQty2,
            storeCount: r.workingStores?.length || 1,
            sales12m: r.sales12m || {},
            codeGamme: r.codeGamme || null,
        }));

        setIsAnalyzing(true);
        let completed = 0;
        let errors = 0;

        setProgress({ current: 0, total: productPayloads.length, message: "Initialisation...", errors: 0 });

        try {
            const CONCURRENCY = 3; // Réduit pour éviter les 429 trop fréquents
            const remaining = [...productPayloads];

            const processNext = async () => {
                if (isCancelledRef.current) return;

                const payload = remaining.shift();
                if (!payload) return;

                // Marquer temporairement comme loading dans le store pour le feedback visuel individuel
                setInsight(payload.codein, "", false);
                // Note: setInsight dans le store actuel met le status à "done". 
                // Pour bien faire, il faudrait une action setStatusLoading dans le store.
                // Ici, on va au moins vider l'insight pour montrer que ça bouge.

                try {
                    let res: Response | null = null;
                    const MAX_RETRIES = 2;

                    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                        if (isCancelledRef.current) break;

                        res = await fetch("/api/ai/analyze", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload)
                        });

                        if (res.status === 429 && attempt < MAX_RETRIES) {
                            const errData = await res.json().catch(() => ({}));
                            const waitSecs = errData.retryAfter ?? (15 * attempt);
                            for (let t = waitSecs; t > 0; t--) {
                                if (isCancelledRef.current) break;
                                setProgress(prev => ({ ...prev, message: `⏳ ${completed}/${productPayloads.length} — Limite API, reprise dans ${t}s...` }));
                                await new Promise(r => setTimeout(r, 1000));
                            }
                            continue;
                        }
                        break;
                    }

                    if (isCancelledRef.current) return;

                    if (!res || !res.ok) {
                        errors++;
                    } else {
                        const data: AnalysisResult = await res.json();
                        // On met à jour l'insight dans tous les cas pour qu'il s'affiche
                        setInsight(data.codein, data.insight, false);

                        // Si une recommandation est trouvée, on l'applique à la gamme
                        if (data.recommandation) {
                            setDraftGamme(data.codein, data.recommandation);
                        }
                    }
                } catch {
                    errors++;
                } finally {
                    if (!isCancelledRef.current) {
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
                message: isCancelledRef.current
                    ? `Analyse interrompue (${completed} traités)`
                    : `Analyse terminée ! (${errors > 0 ? errors + " erreurs" : "succès"})`,
            }));

            setTimeout(() => setIsAnalyzing(false), 3000);

        } catch (error) {
            console.error("Erreur globale lors de l'analyse:", error);
            setIsAnalyzing(false);
        }
    };

    if (isAnalyzing) {
        return (
            <div className="flex items-center gap-4 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800">
                <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
                <div className="flex flex-col min-w-[150px]">
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
                <button
                    onClick={handleStop}
                    className="p-1 hover:bg-indigo-100 dark:hover:bg-indigo-800 rounded-lg transition-colors text-indigo-600 dark:text-indigo-400"
                    title="Arrêter l'analyse"
                >
                    <XCircle className="w-5 h-5" />
                </button>
            </div>
        );
    }

    if (progress.current > 0 && !isAnalyzing) {
        return (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 cursor-default">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                    {progress.errors > 0
                        ? `Terminé (${progress.current - progress.errors}/${progress.total} OK)`
                        : `Analyse terminée (${progress.total} produits)`
                    }
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
