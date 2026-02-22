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

        // Benchmarks par Rayon (Nomenclature Niveau 2)
        const rayonStats = new Map<string, { qty1: number[], qty2: number[] }>();
        rows.forEach((r: any) => {
            const rayon = r.libelleNiveau2 || "Général";
            if (!rayonStats.has(rayon)) rayonStats.set(rayon, { qty1: [], qty2: [] });
            const stats = rayonStats.get(rayon)!;
            const sc = r.workingStores?.length || 1;
            if (sc === 1) stats.qty1.push(r.totalQuantite || 0);
            else stats.qty2.push(r.totalQuantite || 0);
        });

        const rayonBenchmarks = new Map<string, { avg1: number, avg2: number }>();
        rayonStats.forEach((stats, rayon) => {
            const totalCount = stats.qty1.length + stats.qty2.length;
            // Seuil de 3 produits pour justifier un benchmark spécifique par rayon
            if (totalCount >= 3) {
                rayonBenchmarks.set(rayon, {
                    avg1: stats.qty1.length > 0 ? stats.qty1.reduce((a, b) => a + b, 0) / stats.qty1.length : 0,
                    avg2: stats.qty2.length > 0 ? stats.qty2.reduce((a, b) => a + b, 0) / stats.qty2.length : 0
                });
            }
        });

        const productPayloads: ProductAnalysisInput[] = rows.map(r => {
            const sc = r.workingStores?.length || 1;
            const weight = sc === 1 ? 2 : 1; // On ramène tout sur une base 2 magasins
            const rb = rayonBenchmarks.get(r.libelleNiveau2 || "Général");

            return {
                codein: r.codein,
                libelle1: r.libelle1 || "",
                libelleNiveau2: r.libelleNiveau2 || "Général",
                totalCa: r.totalCa || 0,
                tauxMarge: r.tauxMarge || 0,
                totalQuantite: r.totalQuantite || 0,
                weightedTotalQuantite: (r.totalQuantite || 0) * weight,
                weightedTotalCa: (r.totalCa || 0) * weight,
                avgTotalQuantite: avgQty,
                avgQtyGroup1: avgQty1,
                avgQtyGroup2: avgQty2,
                avgQtyRayon1: rb ? rb.avg1 : avgQty1,
                avgQtyRayon2: rb ? rb.avg2 : avgQty2,
                storeCount: sc,
                sales12m: Object.fromEntries(
                    Object.entries(r.sales12m || {}).map(([month, val]) => [month, val * weight])
                ),
                codeGamme: r.codeGamme || null,
                score: r.score || 0,
                regularityScore: Object.values(r.sales12m || {}).filter(v => v > 0).length,
            };
        });

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
                // Vider aussi la recommandation (A, C, Z) pour montrer que c'est en cours de recalcul
                setDraftGamme(payload.codein, "Aucune");
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
            <div className="flex items-center gap-4 h-10 px-4 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)] shadow-sm">
                <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />
                <div className="flex flex-col min-w-[150px]">
                    <span className="text-[10px] font-bold text-[var(--accent)] leading-none">
                        {progress.message}
                    </span>
                    <div className="w-full bg-[var(--bg-elevated)] rounded-full h-1 mt-1 overflow-hidden">
                        <div
                            className="bg-[var(--accent)] h-1 rounded-full transition-all duration-300"
                            style={{ width: `${Math.max(5, (progress.current / progress.total) * 100)}%` }}
                        ></div>
                    </div>
                </div>
                <button
                    onClick={handleStop}
                    className="p-1 hover:bg-[var(--bg-elevated)] rounded-lg transition-colors text-[var(--text-muted)] hover:text-[var(--accent-error)]"
                    title="Arrêter l'analyse"
                >
                    <XCircle className="w-4 h-4" />
                </button>
            </div>
        );
    }

    if (progress.current > 0 && !isAnalyzing) {
        return (
            <div className="flex items-center gap-2 h-10 px-4 rounded-xl bg-[var(--accent-success-bg)] border border-[var(--accent-success)] shadow-sm cursor-default">
                <CheckCircle2 className="w-4 h-4 text-[var(--accent-success)]" />
                <span className="text-xs font-bold text-[var(--accent-success)]">
                    {progress.errors > 0
                        ? `Terminé (${progress.current - progress.errors}/${progress.total})`
                        : `Analyse Terminée`
                    }
                </span>
            </div>
        );
    }

    return (
        <button
            onClick={handleAnalyze}
            className="group flex items-center justify-center gap-2 h-10 px-6 rounded-xl text-sm font-black transition-all shadow-md bg-[var(--accent)] text-white hover:brightness-110 active:scale-95 border border-white/10"
        >
            <Sparkles className="w-4 h-4" />
            Analyse IA
        </button>
    );
}
