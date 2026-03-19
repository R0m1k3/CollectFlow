"use client";

import React, { useState } from "react";

import { Loader2, AlertCircle, Sparkles, Maximize2 } from "lucide-react";
import { AiExplanationModal } from "./ai-explanation-modal";
import { useAiCopilotStore } from "../store/use-ai-copilot-store";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import type { ProductRow } from "@/types/grid";


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

        // Produit sans aucune vente sur 12 mois → Z direct, pas d'appel IA
        if (row.totalQuantite === 0) {
            setDraftGamme(row.codein, "Z");
            useAiCopilotStore.getState().setInsight(row.codein, "Aucune vente sur 12 mois — produit classé Z automatiquement.");
            return;
        }

        // Stock mort absolu : CA < 100€ ET quantité < 30 → Z direct, aucune analyse IA
        if ((row.totalCa ?? 0) < 100 && (row.totalQuantite ?? 0) < 30) {
            setDraftGamme(row.codein, "Z");
            useAiCopilotStore.getState().setInsight(row.codein, `CA < 100€ (${(row.totalCa ?? 0).toFixed(0)}€) et quantité < 30 (${row.totalQuantite} uté) — stock mort absolu, classé Z automatiquement.`);
            return;
        }

        // Reset Visuel Immédiat
        setLoading(row.codein);
        setDraftGamme(row.codein, "Aucune");

        // Fetch supplier context
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

        // Calcul régularité et inactivité
        const regScore = Object.values(row.sales12m || {}).filter((v: any) => v > 0).length;
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

        // Score et verdict pré-calculés par score-engine.ts
        const score = row.score ?? 0;
        const verdict: "A" | "Z" = score >= 45 ? "A" : "Z";

        const sc = row.workingStores?.length || 1;
        const weight = sc === 1 ? 2 : 1;

        analyzeProduct({
            codein: row.codein,
            noid: row.noid,
            libelle1: row.libelle1,
            libelleNiveau2: row.libelleNiveau2,
            totalCa: row.totalCa,
            tauxMarge: row.tauxMarge,
            totalQuantite: row.totalQuantite,
            storeCount: sc,
            sales12m: row.sales12m,
            codeGamme: row.codeGamme,
            score: score,
            regularityScore: regScore,
            lastMonthWithSale: lastMonth,
            inactivityMonths: inactivity,
            weightedTotalQuantite: (row.totalQuantite || 0) * weight,
            weightedTotalCa: (row.totalCa || 0) * weight,
            avgQtyFournisseur: row.avgQtyFournisseur,
            avgQtyRayon: row.avgQtyRayon,
            shareCa: row.shareCa,
            shareMarge: row.shareMarge,
            shareQty: row.shareQty,
            totalFournisseurCa: row.totalFournisseurCa,
            codeFournisseur: row.codeFournisseur,
            totalMagasins: 2,
            prixVente: row.prixVente,
            unitsPerStorePerMonth: row.unitsPerStorePerMonth,
            caPerStorePerYear: row.caPerStorePerYear,
            stockActuel: row.stockActuel,
            stockTotal: row.stockTotal,
            pcb: row.pcb,
            commandesEnCours: row.commandesEnCours,
            nbJoursDerniereVente: row.nbJoursDerniereVente,
            derniereVente: row.derniereVente,
            supplierContext: supplierContext,
            scoring: {
                score,
                verdict,
                isRecent: row.isRecent ?? false,
                isLastProduct: row.isLastProduct ?? false,
                isTop30Supplier: row.isTop30Supplier ?? false,
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
                        Doublon probable
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
