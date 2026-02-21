"use client";

import React, { useState } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { ProductRow } from "@/types/grid";

export function BulkAiAnalyzer() {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, message: "", errors: 0 });
    const setDraftGamme = useGridStore(state => state.setDraftGamme);
    const setInsight = useAiCopilotStore(state => state.setInsight);

    const handleAnalyze = async () => {
        const { rows } = useGridStore.getState();
        const supplierTotalCa = rows.reduce((acc, row) => acc + (row.totalCa || 0), 0);
        const supplierTotalMarge = rows.reduce((acc, row) => acc + (row.totalMarge || 0), 0);

        console.log("[BulkAiAnalyzer] Starting analysis on", rows.length, "rows", { supplierTotalCa, supplierTotalMarge });

        setIsAnalyzing(true);
        let completed = 0;

        try {
            // Group by Nomenclature (libelle3 or a fallback)
            const groups: Record<string, ProductRow[]> = {};
            rows.forEach(r => {
                const rayon = r.libelle3 || "Non classifié";
                if (!groups[rayon]) groups[rayon] = [];
                groups[rayon].push(r);
            });

            const CHUNK_SIZE = 50;
            const chunks: { rayon: string; items: ProductRow[] }[] = [];

            for (const [rayon, items] of Object.entries(groups)) {
                for (let i = 0; i < items.length; i += CHUNK_SIZE) {
                    chunks.push({ rayon, items: items.slice(i, i + CHUNK_SIZE) });
                }
            }

            setProgress({ current: 0, total: chunks.length, message: "Initialisation...", errors: 0 });

            // Process with a continuous concurrency limit
            const CONCURRENCY = 3;
            const remainingChunks = [...chunks];

            const processNext = async () => {
                const chunk = remainingChunks.shift();
                if (!chunk) return;

                const payloadProducts = chunk.items.map(r => ({
                    codein: r.codein,
                    nom: r.libelle1,
                    ca: r.totalCa || 0,
                    ventes: r.totalQuantite || 0,
                    marge: r.totalMarge ? parseFloat(((r.totalMarge / (r.totalCa || 1)) * 100).toFixed(1)) : 0,
                    score: r.score || 0,
                    codeGamme: r.codeGamme || "N/A",
                    sales12m: r.sales12m || {},
                    storeCount: r.workingStores?.length || 1,
                    nomenclature: `${r.libelleNiveau1 || ""} > ${r.libelleNiveau2 || ""} > ${r.libelle3 || ""}`
                }));

                try {
                    let res: Response | null = null;
                    const MAX_CHUNK_RETRIES = 3;

                    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
                        res = await fetch("/api/ai/batch-analyze", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                rayon: chunk.rayon,
                                products: payloadProducts,
                                supplierTotalCa,
                                supplierTotalMarge
                            })
                        });

                        if (res.status === 429 && attempt < MAX_CHUNK_RETRIES) {
                            const errData = await res.json().catch(() => ({}));
                            const waitSecs = errData.retryAfter ?? (30 * attempt);
                            for (let t = waitSecs; t > 0; t--) {
                                setProgress(prev => ({ ...prev, message: `⏳ Lot ${completed + 1}/${chunks.length} — Limite API, reprise dans ${t}s...` }));
                                await new Promise(r => setTimeout(r, 1000));
                            }
                            continue;
                        }
                        break;
                    }

                    if (!res || !res.ok) {
                        const errText = await res?.text().catch(() => "");
                        console.error(`[BulkAiAnalyzer] Erreur HTTP sur le lot ${chunk.rayon}:`, errText);
                        setProgress(prev => ({ ...prev, errors: prev.errors + 1 }));
                    } else {
                        const data = await res.json();
                        if (data && Array.isArray(data.results)) {
                            data.results.forEach((reco: any) => {
                                if (reco.codein && reco.recommandationGamme) {
                                    setDraftGamme(reco.codein, reco.recommandationGamme);
                                    const justification = `Gamme ${reco.recommandationGamme} — ${reco.justificationCourte || "Analyse effectuée."}`;
                                    setInsight(reco.codein, justification, reco.isDuplicate ?? false);
                                }
                            });
                        }
                    }
                } catch (e) {
                    console.error(`[BulkAiAnalyzer] Failed fetch for chunk ${chunk.rayon}:`, e);
                    setProgress(prev => ({ ...prev, errors: prev.errors + 1 }));
                } finally {
                    completed++;
                    setProgress(prev => ({
                        ...prev,
                        current: completed,
                        message: completed === chunks.length ? "Analyse terminée" : `Analyse: ${completed}/${chunks.length} lots`
                    }));
                    // Process next chunk in the same worker
                    await processNext();
                }
            };

            // Start workers
            const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => processNext());
            await Promise.all(workers);

            setProgress(prev => ({ ...prev, current: completed, total: chunks.length, message: `Analyse terminée ! (${prev.errors > 0 ? prev.errors + " erreurs" : "succès"})` }));
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
