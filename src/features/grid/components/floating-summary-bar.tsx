"use client";

import { useGridStore } from "@/features/grid/store/use-grid-store";

import { BulkAiAnalyzer } from "./bulk-ai-analyzer";
import { useSaveDrafts } from "@/features/grid/hooks/use-save-drafts";
import { Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { useState, useTransition } from "react";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    // Determine color based on label to match the prototype
    const valColor = label.includes("CA") || label.includes("Marge") ? "text-emerald-600 dark:text-emerald-400" : "text-slate-900 dark:text-white";
    return (
        <div className="flex flex-col items-center">
            <span className="text-slate-500 text-[10px] uppercase font-black mb-1 tracking-tighter">{label}</span>
            <span className={`font-mono-nums font-black text-xl ${valColor}`}>{value}</span>
            {sub && <span className="text-emerald-600 dark:text-emerald-500 text-[11px] font-bold">{sub}</span>}
        </div>
    );
}

export function FloatingSummaryBar() {
    const { summary, draftChanges, rows, filters } = useGridStore();
    const [isPending, startTransition] = useTransition();
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

    const visibleCodeins = rows.map(r => r.codein);
    const { save, hasDrafts, count } = useSaveDrafts(filters.magasin || "TOTAL", visibleCodeins);

    const handleSave = () => {
        startTransition(async () => {
            const result = await save();
            setSaveStatus(result.success ? "success" : "error");
            setTimeout(() => setSaveStatus("idle"), 3000);
        });
    };

    return (
        <div
            className="fixed bottom-6 left-[264px] right-6 p-4 flex justify-between items-center shadow-lg border rounded-xl z-50 transition-colors bg-slate-100 dark:bg-slate-800"
            style={{
                borderColor: hasDrafts ? "rgba(234, 179, 8, 0.5)" : "var(--border-strong)",
            }}
        >
            <div className="text-xs font-bold px-4 py-2 rounded-full border flex items-center gap-2 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-500">
                {hasDrafts && (
                    <span className="ml-2 text-[10px] font-black uppercase text-amber-600 dark:text-amber-500 bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800">
                        {count} modif.
                    </span>
                )}
            </div>

            <div className="flex space-x-12 items-center">
                <Stat
                    label="Volume Total Vendu"
                    value={Math.round(summary.totalQuantite).toLocaleString("fr-FR")}
                />
                <Stat
                    label="CA Global Généré"
                    value={summary.totalCa.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}
                />
                <Stat
                    label="Taux de Marge Moyen"
                    value={`${summary.tauxMargeGlobal.toFixed(1)}%`}
                    sub={summary.totalMarge.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}
                />
            </div>

            <div className="flex space-x-3 items-center">
                <BulkAiAnalyzer />

                <button
                    onClick={async () => {
                        const currentState = useGridStore.getState();
                        const currentDrafts = currentState.draftChanges;
                        const currentRows = currentState.rows;

                        const modifiedRows = currentRows.filter(r => {
                            const currentGamme = currentDrafts[r.codein] ?? r.codeGamme;
                            return currentGamme !== r.codeGammeInit;
                        });

                        if (modifiedRows.length === 0) {
                            alert("Aucun changement détecté par rapport à l'état initial.");
                            return;
                        }

                        const changes = modifiedRows.map(r => ({
                            codein: r.codein,
                            gtin: r.gtin,
                            codeFournisseur: r.codeFournisseur,
                            gamme: (currentDrafts[r.codein] ?? r.codeGamme) as string,
                        }));

                        const nomFournisseur = modifiedRows[0].nomFournisseur;

                        try {
                            const res = await fetch("/api/export/modified-gammes", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ nomFournisseur, changes }),
                            });

                            if (!res.ok) throw new Error("Erreur lors de l'export");

                            const blob = await res.blob();
                            const url = window.URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `Modifications_Gammes_${nomFournisseur.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.xlsx`;
                            a.click();
                            window.URL.revokeObjectURL(url);
                        } catch (error) {
                            console.error(error);
                            alert("Une erreur s'est produite lors de l'export Excel.");
                        }
                    }}
                    className="h-10 px-6 rounded-xl text-sm font-bold transition-all active:scale-95 border hover:brightness-105"
                    style={{
                        background: "var(--action-secondary-bg)",
                        color: "var(--action-secondary-text)",
                        borderColor: "var(--action-secondary-border)"
                    }}
                >
                    Export Excel
                </button>

                <button
                    onClick={handleSave}
                    disabled={!hasDrafts || isPending}
                    className="h-10 px-6 flex items-center justify-center gap-2 rounded-xl text-sm font-black transition-all shadow-lg active:scale-95 text-white hover:brightness-110 disabled:opacity-50"
                    style={{
                        background: "var(--brand-solid)",
                    }}
                >
                    {isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : saveStatus === "success" ? (
                        <CheckCircle className="w-4 h-4" />
                    ) : saveStatus === "error" ? (
                        <AlertCircle className="w-4 h-4" />
                    ) : null}
                    {isPending ? "Validation..." : "Valider"}
                </button>
            </div>
        </div>
    );
}
