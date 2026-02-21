"use client";

import { useEffect, useState, useTransition } from "react";
import { HeatmapGrid } from "@/features/grid/components/heatmap-grid";
import { FloatingSummaryBar } from "@/features/grid/components/floating-summary-bar";
import { BulkActionToolbar } from "@/features/grid/components/bulk-action-toolbar";
import { GridFilterBar } from "@/features/grid/components/grid-filter-bar";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useSaveDrafts } from "@/features/grid/hooks/use-save-drafts";
import type { ProductRow } from "@/types/grid";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";

import { useScoreSettingsStore } from "@/features/score/store/use-score-settings-store";
import { computeProductScores } from "@/lib/score-engine";

interface GridClientProps {
    initialRows: ProductRow[];
    codeFournisseur: string;
    nomFournisseur: string;
    fournisseurs: { code: string; nom: string }[];
    magasins: { code: string; nom: string }[];
    magasin: string;
    nomenclature: any; // Type defined in components if needed
}

export function GridClient({ initialRows, nomFournisseur, fournisseurs, magasins, magasin, nomenclature }: GridClientProps) {
    const setRows = useGridStore((s) => s.setRows);
    const seuilAxeFort = useScoreSettingsStore((s) => s.seuilAxeFort);
    const bonusParAxe = useScoreSettingsStore((s) => s.bonusParAxe);

    const [selectedCodeins, setSelectedCodeins] = useState<string[]>([]);
    const [isPending, startTransition] = useTransition();
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
    const { save, hasDrafts, count } = useSaveDrafts(magasin);

    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsMounted(true);
    }, []);

    useEffect(() => {
        if (!isMounted) return;
        // Deep clone to avoid mutating the React prop directly across re-renders
        const rowsCopy = JSON.parse(JSON.stringify(initialRows));
        const scoredRows = computeProductScores(rowsCopy, { seuilAxeFort, bonusParAxe });
        setRows(scoredRows);
    }, [initialRows, setRows, seuilAxeFort, bonusParAxe, isMounted]);

    const handleSave = () => {
        startTransition(async () => {
            const result = await save();
            setSaveStatus(result.success ? "success" : "error");
            setTimeout(() => setSaveStatus("idle"), 3000);
        });
    };

    if (!isMounted) {
        return <div className="p-8 text-center animate-pulse text-muted italic">Initialisation de la grille...</div>;
    }

    const activeStoreNom = magasins.find(m => m.code === magasin)?.nom || "National (Total)";

    return (
        <div className="space-y-3 pb-20">
            {/* Header */}
            <div className="flex items-end justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Révision d&apos;Assortiment</h1>
                    <p className="text-[13px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                        <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{nomFournisseur}</span>
                        {" "}• <span className="font-medium" style={{ color: "var(--text-muted)" }}>{activeStoreNom}</span>
                        {" "}• {initialRows.length} références
                    </p>
                </div>
                {hasDrafts && (
                    <button
                        onClick={handleSave}
                        disabled={isPending}
                        className="flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold rounded-lg disabled:opacity-60 transition-colors"
                    >
                        {isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : saveStatus === "success" ? (
                            <CheckCircle className="w-4 h-4" />
                        ) : saveStatus === "error" ? (
                            <AlertCircle className="w-4 h-4" />
                        ) : null}
                        {isPending
                            ? "Sauvegarde..."
                            : saveStatus === "success"
                                ? "Sauvegardé !"
                                : saveStatus === "error"
                                    ? "Erreur"
                                    : `Valider ${count} changement${count > 1 ? "s" : ""}`}
                    </button>
                )}
            </div>

            {/* Filters */}
            <GridFilterBar fournisseurs={fournisseurs} magasins={magasins} nomenclature={nomenclature} />

            {/* Bulk toolbar (contextual) */}
            <BulkActionToolbar
                selectedCodeins={selectedCodeins}
                onClearSelection={() => setSelectedCodeins([])}
            />

            {/* Main grid */}
            <HeatmapGrid
                onSelectionChange={setSelectedCodeins}
            />

            {/* Summary bar */}
            <FloatingSummaryBar />
        </div>
    );
}
