"use client";

import { Bot, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import type { ProductRow } from "@/types/grid";
import { cn } from "@/lib/utils";

import { useGridStore } from "@/features/grid/store/use-grid-store";

interface AiInsightBlockProps {
    row: ProductRow;
}

export function AiInsightBlock({ row }: AiInsightBlockProps) {
    const { insights, analyzeProduct } = useAiCopilotStore();
    const setDraftGamme = useGridStore(state => state.setDraftGamme);
    const insight = insights[row.codein];
    const status = insight?.status ?? "idle";

    const handleAnalyze = () => {
        if (status === "loading") return;

        // Vider la recommandation actuelle avant de relancer l'IA
        setDraftGamme(row.codein, "Aucune");

        const regScore = Object.values(row.sales12m || {}).filter(v => v > 0).length;
        const weight = (row.workingStores?.length || 1) === 1 ? 2 : 1;

        // Calcul de l'inactivité (Récence)
        const allMonths = Object.keys(row.sales12m || {});
        const referenceMonth = allMonths.length > 0 ? Math.max(...allMonths.map(m => parseInt(m))).toString() : "";

        const salesMonths = Object.entries(row.sales12m || {})
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
            projectedTotalQuantite: regScore > 0 ? (row.totalQuantite * weight * (12 / regScore)) : (row.totalQuantite * weight),
            projectedTotalCa: regScore > 0 ? (row.totalCa * weight * (12 / regScore)) : (row.totalCa * weight),
            lastMonthWithSale: lastMonth,
            inactivityMonths: inactivity,
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
            <div className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-500">
                <AlertCircle className="w-3 h-3" />
                <span>Erreur</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-1 group cursor-pointer" onClick={handleAnalyze} title="Cliquer pour re-analyser">
            <div className="flex items-start gap-1.5">
                <Bot className="w-3.5 h-3.5 mt-0.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <span className={cn("text-[11px] italic line-clamp-2 leading-[1.3]")} style={{ color: "var(--text-secondary)" }}>
                    {insight?.insight}
                </span>
            </div>
            {insight?.isDuplicate && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 px-1.5 py-0.5 rounded-full w-fit">
                    ⚠️ Doublon probable
                </span>
            )}
        </div>
    );
}
