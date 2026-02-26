import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useAiCopilotStore } from "@/features/ai-copilot/store/use-ai-copilot-store";

import { BulkAiAnalyzer } from "./bulk-ai-analyzer";
import { useSaveDrafts } from "@/features/grid/hooks/use-save-drafts";
import { Loader2, CheckCircle, AlertCircle, RotateCcw, Camera } from "lucide-react";
import { useState, useTransition } from "react";
import { saveSnapshot } from "@/features/snapshots/api/save-snapshot";
import { SuccessModal } from "@/components/shared/success-modal";

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
    const { summary, resetDrafts, rows, filters, draftChanges } = useGridStore();
    const { resetInsights } = useAiCopilotStore();
    const [isPending, startTransition] = useTransition();
    const [isSavingSnapshot, setIsSavingSnapshot] = useState(false);
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
    const [modal, setModal] = useState<{ isOpen: boolean, title: string, message: string }>({
        isOpen: false,
        title: "",
        message: ""
    });

    const visibleCodeins = rows.map(r => r.codein);
    const { save, hasDrafts, count } = useSaveDrafts(filters.magasin || "TOTAL", visibleCodeins);

    const handleSave = () => {
        startTransition(async () => {
            const result = await save();
            setSaveStatus(result.success ? "success" : "error");
            setTimeout(() => setSaveStatus("idle"), 3000);
        });
    };

    const handleReset = () => {
        if (window.confirm("Es-tu sûr de vouloir annuler tous les changements non enregistrés (gammes et analyses IA) ?")) {
            resetDrafts();
            resetInsights();
        }
    };

    const handleSnapshot = async (labelOverride?: string, type: "snapshot" | "export" = "snapshot") => {
        if (rows.length === 0) return;
        setIsSavingSnapshot(true);
        try {
            const modifiedRows = rows.filter(r => draftChanges[r.codein]);
            const changes = Object.fromEntries(
                modifiedRows.map(r => [
                    r.codein,
                    {
                        before: r.codeGamme,
                        after: draftChanges[r.codein] as string
                    }
                ])
            );

            const res = await saveSnapshot({
                codeFournisseur: filters.codeFournisseur || rows[0].codeFournisseur,
                nomFournisseur: rows[0].nomFournisseur,
                magasin: filters.magasin || "TOTAL",
                label: labelOverride || `${type === 'export' ? 'Export' : 'Session'} ${rows[0].nomFournisseur} — ${new Date().toLocaleTimeString()}`,
                changes,
                type,
                summary: {
                    totalRows: summary.totalRows,
                    totalCa: summary.totalCa,
                    totalMarge: summary.totalMarge,
                    tauxMargeGlobal: summary.tauxMargeGlobal,
                }
            });

            if (res.success) {
                if (!labelOverride) {
                    setModal({
                        isOpen: true,
                        title: "Snapshot Enregistré",
                        message: "Votre session de travail a été sauvegardée avec succès."
                    });
                }
                return res.snapshotId;
            } else {
                throw new Error(res.error);
            }
        } catch (err) {
            console.error(err);
            if (!labelOverride) {
                const msg = err instanceof Error ? err.message : String(err);
                setModal({
                    isOpen: true,
                    title: "Erreur Snapshot",
                    message: `Impossible de créer le snapshot : ${msg}`
                });
            }
        } finally {
            setIsSavingSnapshot(false);
        }
    };

    return (
        <div
            className="fixed bottom-6 left-[264px] right-6 p-4 flex justify-between items-center shadow-lg border rounded-xl z-50 transition-colors bg-slate-100 dark:bg-slate-800"
            style={{
                borderColor: hasDrafts ? "rgba(234, 179, 8, 0.5)" : "var(--border-strong)",
            }}
        >
            <div className="flex items-center bg-white dark:bg-slate-900 shadow-sm border border-slate-200 dark:border-slate-800 rounded-full px-1.5 py-1.5 h-10">
                <button
                    onClick={handleReset}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors rounded-full"
                    title="Réinitialiser la page"
                >
                    <RotateCcw className="w-4 h-4" />
                </button>

                <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

                <button
                    onClick={() => handleSnapshot()}
                    disabled={isSavingSnapshot}
                    className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors rounded-full disabled:opacity-50"
                    title="Prendre un snapshot de la session"
                >
                    {isSavingSnapshot ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                </button>

                {hasDrafts && (
                    <>
                        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />
                        <span className="ml-1 px-3 h-7 flex items-center justify-center rounded-full text-[11px] font-black tracking-wide text-[#b45309] dark:text-[#78350f] bg-[#fdf08a] hover:bg-[#fde047] transition-colors border border-[#fde047]/50 shadow-sm uppercase">
                            {count} MODIF.
                        </span>
                    </>
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

                        // Auto-save snapshot for history
                        await handleSnapshot(`Export ${nomFournisseur} — ${new Date().toLocaleTimeString()}`, "export");

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
                    className="btn-action btn-action-secondary"
                >
                    Export Excel
                </button>

                <button
                    onClick={handleSave}
                    disabled={!hasDrafts || isPending}
                    className="btn-action btn-action-primary"
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

            <SuccessModal
                isOpen={modal.isOpen}
                onClose={() => setModal(prev => ({ ...prev, isOpen: false }))}
                title={modal.title}
                message={modal.message}
            />
        </div>
    );
}
