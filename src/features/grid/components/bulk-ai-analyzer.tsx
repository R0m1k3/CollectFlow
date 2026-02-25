"use client";

import React, { useState, useRef } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import { ScoringEngine } from "@/features/ai-copilot/business/scoring-engine";
import { Sparkles, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { ProductRow, GammeCode } from "@/types/grid";
import { ProductAnalysisInput } from "@/features/ai-copilot/models/ai-analysis.types";
import { SupplierAiContextModal } from "./supplier-ai-context-modal";

export function BulkAiAnalyzer() {
    const rows = useGridStore((s) => s.rows);
    const supplierCode = rows.length > 0 ? rows[0].codeFournisseur : null;
    const supplierName = rows.length > 0 ? rows[0].nomFournisseur : null;

    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, message: "", errors: 0 });
    const isCancelledRef = useRef(false);

    const batchSetDraftGamme = useGridStore((s) => s.batchSetDraftGamme);
    const setDraftGamme = useGridStore((s) => s.setDraftGamme);
    const { setInsight, batchSetLoading, setError } = useAiCopilotStore();

    const handleStop = () => {
        isCancelledRef.current = true;
        setProgress((prev) => ({ ...prev, message: "Arrêt en cours..." }));
    };

    const handleAnalyze = async () => {
        const { rows } = useGridStore.getState();
        isCancelledRef.current = false;

        const totalQtySum = rows.reduce((sum: number, r: ProductRow) => sum + (r.totalQuantite || 0), 0);
        const avgQty = rows.length > 0 ? totalQtySum / rows.length : 0;

        const rowsGroup1 = rows.filter((r) => (r.workingStores?.length || 1) === 1);
        const rowsGroup2 = rows.filter((r) => (r.workingStores?.length || 1) >= 2);

        const avgQty1 = rowsGroup1.length > 0 ? rowsGroup1.reduce((s: number, r: ProductRow) => s + (r.totalQuantite || 0), 0) / rowsGroup1.length : 0;
        const avgQty2 = rowsGroup2.length > 0 ? rowsGroup2.reduce((s: number, r: ProductRow) => s + (r.totalQuantite || 0), 0) / rowsGroup2.length : 0;

        const rayonStats = new Map<string, { qty1: number[]; qty2: number[] }>();
        rows.forEach((r: ProductRow) => {
            const rayon = r.libelleNiveau2 || "Général";
            if (!rayonStats.has(rayon)) rayonStats.set(rayon, { qty1: [], qty2: [] });
            const stats = rayonStats.get(rayon)!;
            const sc = r.workingStores?.length || 1;
            if (sc === 1) stats.qty1.push(r.totalQuantite || 0);
            else stats.qty2.push(r.totalQuantite || 0);
        });

        const rayonBenchmarks = new Map<string, { avg1: number; avg2: number }>();
        rayonStats.forEach((stats, rayon) => {
            const totalCount = stats.qty1.length + stats.qty2.length;
            if (totalCount >= 3) {
                rayonBenchmarks.set(rayon, {
                    avg1: stats.qty1.length > 0 ? stats.qty1.reduce((a, b) => a + b, 0) / stats.qty1.length : 0,
                    avg2: stats.qty2.length > 0 ? stats.qty2.reduce((a, b) => a + b, 0) / stats.qty2.length : 0,
                });
            }
        });

        const initialPayloads: ProductAnalysisInput[] = rows.map((r) => {
            const sc = r.workingStores?.length || 1;
            const weight = sc === 1 ? 2 : 1;
            const rb = rayonBenchmarks.get(r.libelleNiveau2 || "Général");

            const allMonths = Object.keys(r.sales12m || {});
            const referenceMonth = allMonths.length > 0 ? Math.max(...allMonths.map((m) => parseInt(m))).toString() : "";
            const salesMonths = Object.entries(r.sales12m || {})
                .filter(([_, qty]) => qty > 0)
                .map(([m]) => parseInt(m))
                .sort((a, b) => b - a);

            const lastMonth = salesMonths.length > 0 ? salesMonths[0].toString() : "";
            let inactivity = 0;
            if (referenceMonth && lastMonth) {
                const refY = parseInt(referenceMonth.substring(0, 4));
                const refM = parseInt(referenceMonth.substring(4, 6));
                const lastY = parseInt(lastMonth.substring(0, 4));
                const lastM = parseInt(lastMonth.substring(4, 6));
                inactivity = (refY - lastY) * 12 + (refM - lastM);
            }

            const regScore = Object.values(r.sales12m || {}).filter((v) => v > 0).length;

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
                sales12m: Object.fromEntries(Object.entries(r.sales12m || {}).map(([month, val]) => [month, val * weight])),
                codeGamme: r.codeGamme || null,
                score: r.score || 0,
                regularityScore: regScore,
                projectedTotalQuantite: regScore > 0 ? (r.totalQuantite || 0) * weight * (12 / regScore) : (r.totalQuantite || 0) * weight,
                projectedTotalCa: regScore > 0 ? (r.totalCa || 0) * weight * (12 / regScore) : (r.totalCa || 0) * weight,
                lastMonthWithSale: lastMonth,
                inactivityMonths: inactivity,
            };
        });

        // 2. Calculer le scoring algorithmique pour chaque produit
        const productPayloads = initialPayloads.map(p => {
            const scoringRes = ScoringEngine.analyzeRayon(p, initialPayloads);
            return {
                ...p,
                scoring: {
                    compositeScore: scoringRes.compositeScore,
                    decision: scoringRes.decision.recommendation,
                    labelProfil: scoringRes.decision.labelProfil,
                    isTop30Supplier: scoringRes.decision.isTop30Supplier,
                    isRecent: scoringRes.decision.isRecent,
                    isLastProduct: scoringRes.decision.isLastProduct,
                    threshold: scoringRes.decision.threshold,
                }
            };
        });

        setIsAnalyzing(true);
        let completed = 0;
        let errorsCount = 0;

        const totalItems = productPayloads.length;
        setProgress({ current: 0, total: totalItems, message: "Initialisation...", errors: 0 });

        // Reset global ATOMIQUE et IMMÉDIAT
        const codeins = productPayloads.map(p => p.codein);
        batchSetLoading(codeins);

        const gammeChanges: Record<string, GammeCode> = {};
        codeins.forEach(c => gammeChanges[c] = "Aucune");
        batchSetDraftGamme(gammeChanges);

        const CONCURRENCY = 3;
        const remaining = [...productPayloads];

        const processBatch = async () => {
            const workers = Array.from({ length: Math.min(CONCURRENCY, remaining.length) }, async () => {
                while (remaining.length > 0 && !isCancelledRef.current) {
                    const payload = remaining.shift();
                    if (!payload) break;

                    try {
                        let res: Response | null = null;
                        for (let i = 0; i < 3; i++) {
                            if (isCancelledRef.current) break;
                            try {
                                res = await fetch("/api/ai/analyze", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify(payload),
                                });
                                if (res.ok) break;
                                if (res.status === 429) {
                                    await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
                                }
                            } catch (e) {
                                console.error(`Retry ${i} failed for ${payload.codein}`, e);
                            }
                        }

                        if (!res || !res.ok) {
                            setError(payload.codein, "Erreur API");
                            errorsCount++;
                        } else {
                            const data = await res.json();
                            setInsight(payload.codein, data.insight, data.isDuplicate);
                            if (data.recommandation) {
                                setDraftGamme(payload.codein, data.recommandation as GammeCode);
                            }
                        }
                    } catch (err) {
                        console.error(`Error processing ${payload.codein}`, err);
                        setError(payload.codein, "Erreur");
                        errorsCount++;
                    } finally {
                        completed++;
                        setProgress((prev) => ({
                            ...prev,
                            current: completed,
                            message: `Analyse: ${completed}/${totalItems}`,
                            errors: errorsCount,
                        }));
                    }
                }
            });

            await Promise.all(workers);
        };

        await processBatch();

        setProgress((prev) => ({
            ...prev,
            message: isCancelledRef.current ? `Analyse interrompue (${completed}/${totalItems})` : `Analyse terminée ! (${errorsCount > 0 ? errorsCount + " erreurs" : "succès"})`,
        }));

        setTimeout(() => setIsAnalyzing(false), 3000);
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
                    {progress.errors > 0 ? `Terminé (${progress.current - progress.errors}/${progress.total})` : `Analyse Terminée`}
                </span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3">
            <SupplierAiContextModal codeFournisseur={supplierCode} nomFournisseur={supplierName} />
            <button
                onClick={handleAnalyze}
                className="group flex items-center justify-center gap-2 h-10 px-6 rounded-xl text-sm font-black transition-all shadow-md bg-[var(--accent)] text-white hover:brightness-110 active:scale-95 border border-white/10"
            >
                <Sparkles className="w-4 h-4" />
                Analyse IA
            </button>
        </div>
    );
}
