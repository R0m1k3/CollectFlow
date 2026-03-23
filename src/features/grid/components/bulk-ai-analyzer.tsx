"use client";

import React, { useState, useRef, useEffect } from "react";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";
import { ContextProfiler } from "@/features/ai-copilot/business/context-profiler";
import { Sparkles, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { GammeCode } from "@/types/grid";
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
    const { setInsight, batchSetInsights, batchSetLoading, setError } = useAiCopilotStore();

    const prevSupplierRef = useRef(supplierCode);
    useEffect(() => {
        if (supplierCode !== prevSupplierRef.current) {
            if (!isAnalyzing) {
                setProgress({ current: 0, total: 0, message: "", errors: 0 });
            }
            prevSupplierRef.current = supplierCode;
        }
    }, [supplierCode, isAnalyzing]);

    const handleStop = () => {
        isCancelledRef.current = true;
        setProgress((prev) => ({ ...prev, message: "Arrêt en cours..." }));
    };

    const handleAnalyze = async () => {
        const { rows } = useGridStore.getState();
        isCancelledRef.current = false;

        // 1. Fetch AI Context for the Supplier
        let supplierContext = "";
        if (supplierCode) {
            try {
                const ctxRes = await fetch(`/api/ai/context?fournisseur=${supplierCode}`);
                if (ctxRes.ok) {
                    const data = await ctxRes.json();
                    supplierContext = data.context || "";
                }
            } catch (err) {
                console.error("Failed to load supplier context for AI", err);
            }
        }

        // 2a. Produits sans aucune vente → Z direct, sans appel IA (avant de construire les payloads)
        const zeroSalesRows = rows.filter((r) => (r.totalQuantite || 0) === 0);
        if (zeroSalesRows.length > 0) {
            const zChanges: Record<string, GammeCode> = {};
            zeroSalesRows.forEach(r => { zChanges[r.codein] = "Z"; });
            batchSetDraftGamme(zChanges);
            batchSetInsights(zeroSalesRows.map(r => ({
                codein: r.codein,
                insight: "Aucune vente sur 12 mois — produit classé Z automatiquement.",
            })));
        }

        // Construire les payloads uniquement pour les produits avec ventes
        const rowsWithSales = rows.filter((r) => (r.totalQuantite || 0) > 0);
        const initialPayloads: ProductAnalysisInput[] = rowsWithSales.map((r) => {
            const sc = r.workingStores?.length || 1;
            const weight = sc === 1 ? 2 : 1;

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
                noid: r.noid,
                libelle1: r.libelle1 || "",
                libelleNiveau2: r.libelleNiveau2 || "Général",
                codeNomenclatureN2: r.code2 || undefined,
                totalCa: r.totalCa || 0,
                tauxMarge: r.tauxMarge || 0,
                totalQuantite: r.totalQuantite || 0,
                weightedTotalQuantite: (r.totalQuantite || 0) * weight,
                weightedTotalCa: (r.totalCa || 0) * weight,
                storeCount: sc,
                sales12m: Object.fromEntries(Object.entries(r.sales12m || {}).map(([month, val]) => [month, (val as number) * weight])),
                codeGamme: r.codeGamme || null,
                score: r.score || 0,
                regularityScore: regScore,
                lastMonthWithSale: lastMonth,
                inactivityMonths: inactivity,
                codeFournisseur: r.codeFournisseur || undefined,
                avgQtyFournisseur: r.avgQtyFournisseur,
                avgQtyRayon: r.avgQtyRayon,
                shareCa: r.shareCa,
                shareMarge: r.shareMarge,
                shareQty: r.shareQty,
                totalFournisseurCa: r.totalFournisseurCa,
                supplierContext: supplierContext,
            };
        });

        // 2b. Stock mort absolu : CA < 100€ ET quantité < 30 → Z direct, sans appel IA
        const deadStockRows = rows.filter(r =>
            (r.totalQuantite || 0) > 0 &&
            (r.totalCa ?? 0) < 100 && (r.totalQuantite ?? 0) < 30
        );
        if (deadStockRows.length > 0) {
            const zChanges: Record<string, GammeCode> = {};
            deadStockRows.forEach(r => { zChanges[r.codein] = "Z"; });
            batchSetDraftGamme(zChanges);
            batchSetInsights(deadStockRows.map(r => ({
                codein: r.codein,
                insight: `CA < 100€ (${(r.totalCa ?? 0).toFixed(0)}€) et quantité < 30 (${r.totalQuantite} uté) — stock mort absolu, classé Z automatiquement.`,
            })));
        }
        const deadStockCodes = new Set(deadStockRows.map(r => r.codein));

        // 2c. Top 20 réseau → A direct, sans appel IA
        const top20Rows = rows.filter(r =>
            (r.totalQuantite || 0) > 0 &&
            !deadStockCodes.has(r.codein) &&
            ((r.rankingCa != null && r.rankingCa <= 20) || (r.rankingQte != null && r.rankingQte <= 20))
        );
        if (top20Rows.length > 0) {
            const aChanges: Record<string, GammeCode> = {};
            top20Rows.forEach(r => { aChanges[r.codein] = "A"; });
            batchSetDraftGamme(aChanges);
            batchSetInsights(top20Rows.map(r => {
                const rkCa = r.rankingCa != null ? `${r.rankingCa}e CA` : "";
                const rkQte = r.rankingQte != null ? `${r.rankingQte}e Qté` : "";
                const total = r.totalRankedProducts ? ` / ${r.totalRankedProducts.toLocaleString("fr-FR")} produits` : "";
                return {
                    codein: r.codein,
                    insight: `Top 20 réseau (${[rkCa, rkQte].filter(Boolean).join(", ")}${total}) — classé A automatiquement.`,
                };
            }));
        }
        const top20Codes = new Set(top20Rows.map(r => r.codein));

        // Filtrer : ne soumettre à l'IA que les produits avec au moins 1 vente et CA/quantité suffisants
        const payloadsWithSales = initialPayloads.filter(p =>
            (p.totalQuantite || 0) > 0 && !deadStockCodes.has(p.codein) && !top20Codes.has(p.codein)
        );

        // 2c. Context profiling en micro-batches asynchrones
        //    Le score est déjà calculé par score-engine.ts (champ row.score sur chaque ProductRow).
        setIsAnalyzing(true);
        setProgress({ current: 0, total: payloadsWithSales.length, message: "Calcul du contexte...", errors: 0 });

        const SCORING_BATCH_SIZE = 25;
        const productPayloads: ProductAnalysisInput[] = [];

        // Pre-compute context thresholds to prevent O(N^2) and O(N^2 log N) performance freezes
        const contextCache = ContextProfiler.prepareCache(payloadsWithSales);

        // Map codein → row pour récupérer le score et les flags depuis score-engine
        const rowByCodein = new Map(rows.map(r => [r.codein, r]));

        for (let i = 0; i < payloadsWithSales.length; i += SCORING_BATCH_SIZE) {
            if (isCancelledRef.current) break;

            const batch = payloadsWithSales.slice(i, i + SCORING_BATCH_SIZE);

            for (const p of batch) {
                const row = rowByCodein.get(p.codein);
                const score = row?.score ?? p.score ?? 0;
                const verdict: "A" | "Z" = score >= 45 ? "A" : "Z";

                let contextProfile: ProductAnalysisInput["contextProfile"];
                try {
                    contextProfile = ContextProfiler.buildProfile(p, payloadsWithSales, score, contextCache);
                } catch (err) {
                    console.warn(`[BulkAnalyzer] ContextProfiler failed for ${p.codein}:`, err);
                    contextProfile = undefined;
                }

                productPayloads.push({
                    ...p,
                    prixVente: row?.prixVente,
                    unitsPerStorePerMonth: row?.unitsPerStorePerMonth,
                    caPerStorePerYear: row?.caPerStorePerYear,
                    stockActuel: row?.stockActuel,
                    stockTotal: row?.stockTotal,
                    pcb: row?.pcb,
                    commandesEnCours: row?.commandesEnCours,
                    nbJoursDerniereVente: row?.nbJoursDerniereVente,
                    derniereVente: row?.derniereVente,
                    rankingCa: row?.rankingCa,
                    rankingQte: row?.rankingQte,
                    rankingMagCa: row?.rankingMagCa,
                    rankingMagQte: row?.rankingMagQte,
                    totalRankedProducts: row?.totalRankedProducts,
                    contextProfile,
                    scoring: {
                        score,
                        verdict,
                        quadrant: contextProfile?.quadrant,
                        isRecent: row?.isRecent ?? false,
                        isLastProduct: row?.isLastProduct ?? false,
                        isTop30Supplier: row?.isTop30Supplier ?? false,
                    },
                });
            }

            // Yield au navigateur entre chaque batch pour éviter le freeze
            setProgress(prev => ({
                ...prev,
                current: Math.min(i + SCORING_BATCH_SIZE, payloadsWithSales.length),
                message: `Contexte : ${Math.min(i + SCORING_BATCH_SIZE, payloadsWithSales.length)}/${payloadsWithSales.length}`,
            }));
            await new Promise(r => setTimeout(r, 0));
        }

        if (isCancelledRef.current) {
            setIsAnalyzing(false);
            return;
        }
        let completed = 0;
        let errorsCount = 0;

        const totalItems = productPayloads.length;
        setProgress({ current: 0, total: totalItems, message: "Envoi aux modèles IA...", errors: 0 });

        // Reset global ATOMIQUE et IMMÉDIAT
        const codeins = productPayloads.map(p => p.codein);
        batchSetLoading(codeins);

        const gammeChanges: Record<string, GammeCode> = {};
        codeins.forEach(c => gammeChanges[c] = "Aucune");
        batchSetDraftGamme(gammeChanges);

        const CONCURRENCY = 2;
        const remaining = [...productPayloads];

        const processBatch = async () => {
            const workers = Array.from({ length: Math.min(CONCURRENCY, remaining.length) }, async () => {
                while (remaining.length > 0 && !isCancelledRef.current) {
                    const payload = remaining.shift();
                    if (!payload) break;

                    try {
                        let res: Response | null = null;
                        // Jusqu'à 3 tentatives par produit
                        for (let attempt = 0; attempt < 3; attempt++) {
                            if (isCancelledRef.current) break;
                            try {
                                res = await fetch("/api/ai/analyze", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify(payload),
                                });
                                if (res.ok) break; // Succès → sortie de boucle

                                if (res.status === 429) {
                                    // Rate-limit : on attend avant de réessayer
                                    const retryData = await res.json().catch(() => ({}));
                                    const wait = (retryData.retryAfter ?? 30) * 1000;
                                    console.warn(`[BulkAI] Rate limited, retry in ${wait / 1000}s`);
                                    await new Promise((r) => setTimeout(r, Math.min(wait, 15_000)));
                                } else if (res.status === 504 || res.status === 502 || res.status === 503 || res.status === 529) {
                                    // Timeout ou réseau surchargé : on tente de réessayer de suite
                                    console.warn(`[BulkAI] Network issue (${res.status}) for ${payload.codein}, retry #${attempt + 1}`);
                                    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1))); // Exponential backoff (2s, 4s, 6s)
                                } else {
                                    // Autre erreur (500 local, auth, etc.) : ne pas réessayer inutilement
                                    break;
                                }
                            } catch (fetchErr) {
                                console.error(`[BulkAI] Fetch error (attempt ${attempt + 1}) for ${payload.codein}`, fetchErr);
                                await new Promise((r) => setTimeout(r, 1_000)); // Petite pause avant retry réseau
                            }
                        }

                        if (!res || !res.ok) {
                            let errorMsg = res?.status === 504 ? "Timeout IA" : (res?.status === 502 ? "API Surchargée" : `Erreur HTTP ${res?.status}`);

                            // On tente d'extraire le message original s'il y en a un
                            if (res && res.headers.get("content-type")?.includes("application/json")) {
                                try {
                                    const errData = await res.json();
                                    if (errData.error) errorMsg += ` - ${errData.error}`;
                                    if (errData.detail) errorMsg += ` (${errData.detail})`;
                                } catch (e) { /* ignore JSON parse error on error */ }
                            }

                            setError(payload.codein, errorMsg);
                            errorsCount++;
                        } else {
                            const data = await res.json();
                            setInsight(payload.codein, data.insight, data.isDuplicate);
                            if (data.recommandation) {
                                setDraftGamme(payload.codein, data.recommandation as GammeCode);
                            }
                        }
                    } catch (err) {
                        console.error(`[BulkAI] Error processing ${payload.codein}`, err);
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

        // Nettoyer les drafts "Aucune" restants (produits en erreur dont l'IA n'a pas retourné A/Z)
        // Pour éviter que "Valider" ne sauvegarde "Aucune" comme gamme réelle
        const currentDrafts = useGridStore.getState().draftChanges;
        const aucuneCodeins = codeins.filter(c => currentDrafts[c] === "Aucune");
        if (aucuneCodeins.length > 0) {
            const { clearDrafts } = useGridStore.getState();
            clearDrafts(aucuneCodeins);
        }

        setProgress((prev) => ({
            ...prev,
            message: isCancelledRef.current ? `Analyse interrompue (${completed}/${totalItems})` : `Analyse terminée ! (${errorsCount > 0 ? errorsCount + " erreurs" : "succès"})`,
        }));

        setTimeout(() => setIsAnalyzing(false), 3000);
    };

    return (
        <div className="flex items-center gap-3">
            <SupplierAiContextModal codeFournisseur={supplierCode} nomFournisseur={supplierName} />

            {isAnalyzing ? (
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
            ) : progress.current > 0 ? (
                <div className="apple-btn-primary opacity-80 cursor-default">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                        {progress.errors > 0 ? `Terminé (${progress.current - progress.errors}/${progress.total})` : `Analyse Terminée`}
                    </span>
                </div>
            ) : (
                <button
                    onClick={handleAnalyze}
                    className="apple-btn-secondary"
                >
                    <Sparkles className="w-4 h-4" style={{ color: "var(--accent)" }} />
                    Analyse IA
                </button>
            )}
        </div>
    );
}
