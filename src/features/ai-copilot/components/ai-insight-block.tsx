"use client";

import React, { useState } from "react";

import { Bot, Loader2, AlertCircle, Sparkles, Maximize2 } from "lucide-react";
import { AiExplanationModal } from "./ai-explanation-modal";
import { useAiCopilotStore } from "../store/use-ai-copilot-store";
import { ProductAnalysisInput } from "../models/ai-analysis.types";
import { ScoringEngine } from "../business/scoring-engine";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import type { ProductRow } from "@/types/grid";
import { cn } from "@/lib/utils";


interface AiInsightBlockProps {
    row: ProductRow;
}

export function AiInsightBlock({ row }: AiInsightBlockProps) {
    const insight = useAiCopilotStore((s: any) => s.insights[row.codein]);
    const analyzeProduct = useAiCopilotStore((s: any) => s.analyzeProduct);
    const setLoading = useAiCopilotStore((s: any) => s.setLoading);
    const setDraftGamme = useGridStore((s: any) => s.setDraftGamme);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const status = insight?.status ?? "idle";

    const handleAnalyze = async () => {
        if (status === "loading") return;

        // Reset Visuel Immédiat
        setLoading(row.codein);
        setDraftGamme(row.codein, "Aucune");

        const allRows = useGridStore.getState().rows;
        const rayonRows = allRows.filter(r => r.libelleNiveau2 === row.libelleNiveau2);

        // Fetch local context if needed
        let supplierContext = "";
        if (row.codeFournisseur) {
            try {
                const ctxRes = await fetch(`/api/ai/context?fournisseur=${row.codeFournisseur}`);
                if (ctxRes.ok) {
                    const data = await ctxRes.json();
                    supplierContext = data.context || "";
                }
            } catch (err) {
                console.error("Failed to load supplier context for AI", err);
            }
        }

        // Préparation du ScoringEngine
        const regScore = Object.values(row.sales12m || {}).filter((v: any) => v > 0).length;
        const weight = (row.workingStores?.length || 1) === 1 ? 2 : 1;

        // Calcul de l'inactivité
        const allMonths = Object.keys(row.sales12m || {});
        const referenceMonth = allMonths.length > 0 ? Math.max(...allMonths.map(m => parseInt(m))).toString() : "";
        const salesMonths = Object.entries(row.sales12m || {}).filter(([_, qty]: [string, any]) => qty > 0).map(([m]) => parseInt(m)).sort((a, b) => b - a);
        const lastMonth = salesMonths.length > 0 ? salesMonths[0].toString() : "";
        let inactivity = 0;
        if (referenceMonth && lastMonth) {
            const refY = parseInt(referenceMonth.substring(0, 4));
            const refM = parseInt(referenceMonth.substring(4, 6));
            const lastY = parseInt(lastMonth.substring(0, 4));
            const lastM = parseInt(lastMonth.substring(4, 6));
            inactivity = (refY - lastY) * 12 + (refM - lastM);
        }

        // Mapping pour le moteur de scoring
        const mapToInput = (r: ProductRow) => ({
            codein: r.codein,
            libelle1: r.libelle1,
            totalCa: r.totalCa,
            tauxMarge: r.tauxMarge,
            totalQuantite: r.totalQuantite,
            codeFournisseur: r.codeFournisseur,
            storeCount: r.workingStores?.length || 1,
            totalMagasins: 2,
            regularityScore: Object.values(r.sales12m || {}).filter((v: any) => v > 0).length,
            inactivityMonths: 0,
            isLastProductOfSupplier: false,
            sales12m: r.sales12m,
            codeGamme: r.codeGamme,
            score: r.score
        });

        // Calcul du ScoringEngine
        const scoringResult = ScoringEngine.analyzeRayon(mapToInput(row), rayonRows.map(mapToInput));

        analyzeProduct({
            codein: row.codein,
            libelle1: row.libelle1,
            totalCa: row.totalCa,
            tauxMarge: row.tauxMarge,
            totalQuantite: row.totalQuantite,
            sales12m: row.sales12m,
            codeGamme: row.codeGamme,
            score: row.score,
            regularityScore: regScore,
            lastMonthWithSale: lastMonth,
            inactivityMonths: inactivity,
            avgQtyFournisseur: row.avgQtyFournisseur,
            avgQtyRayon: row.avgQtyRayon,
            shareCa: row.shareCa,
            shareMarge: row.shareMarge,
            shareQty: row.shareQty,
            totalFournisseurCa: row.totalFournisseurCa,
            codeFournisseur: row.codeFournisseur,
            totalMagasins: 2,
            supplierContext: supplierContext,
            scoring: {
                compositeScore: scoringResult.compositeScore,
                decision: scoringResult.decision.recommendation,
                labelProfil: scoringResult.decision.labelProfil,
                isTop30Supplier: scoringResult.decision.isTop30Supplier,
                isRecent: scoringResult.decision.isRecent,
                isLastProduct: scoringResult.decision.isLastProduct,
                threshold: scoringResult.decision.threshold
            }
        });
    };

    if (status === "idle") {
        return (
            <button
                onClick={handleAnalyze}
                className="flex items-center gap-1.5 text-[11px] font-medium transition-colors group"
                style={{ color: "var(--text-secondary)" }}
            >
                <Sparkles className="w-3 h-3 text-indigo-500 dark:text-indigo-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-300 transition-colors" />
                <span className="group-hover:text-indigo-600 dark:group-hover:text-indigo-300 transition-colors">Analyser</span>
            </button>
        );
    }

    if (status === "loading") {
        return (
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="italic">Analyse IA...</span>
            </div>
        );
    }

    if (status === "error") {
        return (
            <div
                className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-500 cursor-help"
                title={insight?.insight || "Une erreur inconnue est survenue"}
            >
                <AlertCircle className="w-3 h-3" />
                <span>Erreur</span>
            </div>
        );
    }

    return (
        <>
            <div className="flex flex-col gap-1 group/insight" title="Cliquer pour re-analyser">
                <div className="flex-1 min-w-0 pr-1 group">
                    <p
                        className="text-[11px] leading-snug font-medium text-[var(--text-secondary)] line-clamp-3 cursor-pointer hover:text-[var(--text-primary)] transition-colors relative"
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsModalOpen(true);
                        }}
                    >
                        {insight.insight}
                        <span className="inline-flex ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Maximize2 className="w-2.5 h-2.5 text-[var(--accent)]" />
                        </span>
                    </p>
                </div>
                {insight?.isDuplicate && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 px-1.5 py-0.5 rounded-full w-fit">
                        ⚠️ Doublon probable
                    </span>
                )}
            </div>

            <AiExplanationModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                productName={row.libelle1}
                productCode={row.codein}
                explanation={insight?.insight || ""}
                recommandation={insight?.recommandation}
            />
        </>
    );
}
