"use client";

import { useEffect, useRef, useState, useTransition, useMemo } from "react";
import { HeatmapGrid } from "@/features/grid/components/heatmap-grid";
import { FloatingSummaryBar } from "@/features/grid/components/floating-summary-bar";
import { BulkActionToolbar } from "@/features/grid/components/bulk-action-toolbar";
import { GridFilterBar } from "@/features/grid/components/grid-filter-bar";
import { ExportDropdown } from "@/features/grid/components/export-dropdown";
import { NoSalesTab, countNoSalesIn6Months } from "@/features/grid/components/no-sales-tab";
import { useGridStore } from "@/features/grid/store/use-grid-store";
import { useSaveDrafts } from "@/features/grid/hooks/use-save-drafts";
import type { ProductRow } from "@/types/grid";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";

import { useSearchParams } from "next/navigation";
import { computeProductScores } from "@/lib/score-engine";

interface GridClientProps {
    initialRows: ProductRow[];
    codeFournisseur: string;
    nomFournisseur: string;
    fournisseurs: { code: string; nom: string }[];
    magasins: { code: string; nom: string }[];
    magasin: string;
}

export function GridClient({ initialRows, codeFournisseur, nomFournisseur, fournisseurs, magasins, magasin }: GridClientProps) {
    const { data: session } = useSession();
    const isAdmin = (session?.user as any)?.role === "admin";
    const setRows = useGridStore((s) => s.setRows);
    const rows = useGridStore((s) => s.rows);
    const setActiveGridQuery = useGridStore((s) => s.setActiveGridQuery);
    const setFilter = useGridStore((s) => s.setFilter);
    const setActiveMagasin = useGridStore((s) => s.setActiveMagasin);
    const searchParams = useSearchParams();

    const [selectedCodeins, setSelectedCodeins] = useState<string[]>([]);
    const [isPending, startTransition] = useTransition();
    const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
    const [activeTab, setActiveTab] = useState<"grid" | "no-sales">("grid");

    const noSalesCount = useMemo(() => countNoSalesIn6Months(rows), [rows]);

    const visibleCodeins = initialRows.map(r => r.codein);
    const { save, hasDrafts, count } = useSaveDrafts(magasin, visibleCodeins);

    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Sync active search params to the store
    useEffect(() => {
        if (!isMounted) return;
        const currentQueryString = searchParams.toString();
        // Set the active query, ensuring it starts with ? if not empty
        setActiveGridQuery(currentQueryString ? `?${currentQueryString}` : "");
    }, [searchParams, setActiveGridQuery, isMounted]);

    // Réinitialiser les filtres UNIQUEMENT quand le fournisseur change
    const prevFournisseurRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isMounted) return;
        if (prevFournisseurRef.current !== codeFournisseur) {
            setFilter("codeGamme", null);
            setFilter("code3", null);
            prevFournisseurRef.current = codeFournisseur;
        }
        const scoredRows = computeProductScores([...initialRows]);
        setRows(scoredRows);
    }, [codeFournisseur, initialRows, setRows, setFilter, isMounted]);

    // Synchroniser le magasin actif depuis la prop URL (changement de magasin sans rechargement)
    useEffect(() => {
        if (!isMounted) return;
        setActiveMagasin(magasin || "TOTAL");
    }, [magasin, setActiveMagasin, isMounted]);

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
        <div className="flex flex-col h-full space-y-3 min-h-0 pb-12">
            {/* Header */}
            <div className="flex items-end justify-between shrink-0">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Révision d&apos;Assortiment</h1>
                    <p className="text-[13px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                        <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{nomFournisseur}</span>
                        {" "}• <span className="font-medium" style={{ color: "var(--text-muted)" }}>{activeStoreNom}</span>
                        {" "}• {initialRows.length} références
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div id="grid-toolbar-actions"></div>
                    {isAdmin && <ExportDropdown nomFournisseur={nomFournisseur} />}
                    {isAdmin && hasDrafts && (
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
            </div>

            {/* Filters */}
            <div className="shrink-0 print:hidden">
                <GridFilterBar fournisseurs={fournisseurs} magasins={magasins} />
            </div>

            {/* Tab switcher */}
            <div className="shrink-0 flex gap-0 print:hidden" style={{ borderBottom: "1px solid var(--border)" }}>
                {(["grid", "no-sales"] as const).map(tab => {
                    const isActive = activeTab === tab;
                    return (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium transition-colors"
                            style={{
                                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                                marginBottom: "-1px",
                            }}
                        >
                            {tab === "grid" ? "Assortiment" : "Sans vente 6 mois"}
                            {tab === "no-sales" && noSalesCount > 0 && (
                                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold"
                                    style={{
                                        background: isActive ? "var(--accent)" : "var(--bg-elevated)",
                                        color: isActive ? "white" : "var(--text-secondary)",
                                        border: "1px solid var(--border)",
                                    }}
                                >
                                    {noSalesCount}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Bulk toolbar (contextual) — uniquement sur l'onglet grille */}
            {activeTab === "grid" && (
                <div className="shrink-0 print:hidden">
                    <BulkActionToolbar
                        selectedCodeins={selectedCodeins}
                        onClearSelection={() => setSelectedCodeins([])}
                    />
                </div>
            )}

            {/* Main content */}
            {activeTab === "grid" ? (
                <div className="flex-1 min-h-0 min-w-0">
                    <HeatmapGrid
                        onSelectionChange={setSelectedCodeins}
                        isAdmin={isAdmin}
                    />
                </div>
            ) : (
                <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                    <NoSalesTab />
                </div>
            )}

            {/* Summary bar — uniquement sur l'onglet grille */}
            {activeTab === "grid" && (
                <div className="print:hidden">
                    <FloatingSummaryBar />
                </div>
            )}
        </div>
    );
}
