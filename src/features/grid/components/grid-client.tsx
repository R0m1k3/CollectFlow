"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import type { GridFilters } from "@/types/grid";

interface GridClientProps {
    codeFournisseur: string;
    nomFournisseur: string;
    fournisseurs: { code: string; nom: string }[];
    magasins: { code: string; nom: string }[];
    magasin: string;
    filters: Pick<GridFilters, "code1" | "code2" | "code3">;
}

type GridRowsStreamMessage =
    | { type: "start"; loaded: number; total: null }
    | { type: "chunk"; rows: ProductRow[]; loaded: number; total: number }
    | { type: "done"; loaded: number; total: number }
    | { type: "error"; error: string };

export function GridClient({ codeFournisseur, nomFournisseur, fournisseurs, magasins, magasin, filters }: GridClientProps) {
    const { data: session } = useSession();
    const isAdmin = (session?.user as { role?: string } | undefined)?.role === "admin";
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
    const [isLoadingRows, setIsLoadingRows] = useState(false);
    const [rowsLoaded, setRowsLoaded] = useState(0);
    const [totalRows, setTotalRows] = useState<number | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [showStartOverlay, setShowStartOverlay] = useState(false);

    const noSalesCount = useMemo(() => countNoSalesIn6Months(rows), [rows]);

    const visibleCodeins = useMemo(() => rows.map(r => r.codein), [rows]);
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
    }, [codeFournisseur, setFilter, isMounted]);

    const refreshToken = searchParams.get("_refresh");
    useEffect(() => {
        if (!isMounted) return;

        const controller = new AbortController();
        const params = new URLSearchParams();
        params.set("fournisseur", codeFournisseur);
        params.set("magasin", magasin || "TOTAL");
        if (filters.code1) params.set("code1", filters.code1);
        if (filters.code2) params.set("code2", filters.code2);
        if (filters.code3) params.set("code3", filters.code3);
        if (refreshToken) params.set("refresh", "1");

        let accumulatedRows: ProductRow[] = [];
        setRows([]);
        setRowsLoaded(0);
        setTotalRows(null);
        setLoadError(null);
        setIsLoadingRows(true);
        setShowStartOverlay(true);

        async function loadRows() {
            try {
                const response = await fetch(`/api/grid/rows?${params.toString()}`, {
                    signal: controller.signal,
                    cache: "no-store",
                });
                if (!response.ok || !response.body) {
                    throw new Error(`Chargement impossible (${response.status})`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        const message = JSON.parse(line) as GridRowsStreamMessage;
                        if (message.type === "chunk") {
                            accumulatedRows = accumulatedRows.concat(message.rows);
                            setRows(accumulatedRows);
                            setRowsLoaded(message.loaded);
                            setTotalRows(message.total);
                        } else if (message.type === "done") {
                            setRowsLoaded(message.loaded);
                            setTotalRows(message.total);
                        } else if (message.type === "error") {
                            throw new Error(message.error);
                        }
                    }
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    setLoadError(error instanceof Error ? error.message : "Erreur de chargement");
                }
            } finally {
                if (!controller.signal.aborted) {
                    setIsLoadingRows(false);
                }
            }
        }

        loadRows();

        return () => controller.abort();
    }, [codeFournisseur, magasin, filters.code1, filters.code2, filters.code3, refreshToken, setRows, isMounted]);

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
                        {" "}• {totalRows?.toLocaleString("fr-FR") ?? rows.length.toLocaleString("fr-FR")} références
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {(isLoadingRows || loadError) && (
                        <div
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold"
                            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: loadError ? "var(--accent-error)" : "var(--text-secondary)" }}
                        >
                            {isLoadingRows && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {loadError
                                ? loadError
                                : totalRows
                                    ? `${rowsLoaded.toLocaleString("fr-FR")} / ${totalRows.toLocaleString("fr-FR")}`
                                    : "Chargement produits..."}
                        </div>
                    )}
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

            {/* Overlay de démarrage premium (Glassmorphism semi-bloquant) */}
            {showStartOverlay && isLoadingRows && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-md bg-slate-950/30 dark:bg-black/40 animate-fade-in">
                    <div 
                        className="w-full max-w-md rounded-2xl border p-6 shadow-2xl flex flex-col items-center text-center space-y-5 transition-transform duration-300 transform scale-100"
                        style={{
                            background: "rgba(255, 255, 255, 0.75)",
                            borderColor: "var(--border)",
                            backdropFilter: "blur(20px)",
                            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)"
                        }}
                    >
                        {/* Header avec logo ou icône animée */}
                        <div className="relative flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                            <Loader2 className="w-8 h-8 animate-spin" />
                            <div className="absolute inset-0 rounded-full border border-emerald-500/20 animate-ping duration-1000" />
                        </div>

                        {/* Titre et descriptions */}
                        <div className="space-y-1">
                            <h3 className="text-lg font-bold tracking-tight text-emerald-800 dark:text-emerald-400">
                                Flux d'Assortiment en cours
                            </h3>
                            <p className="text-xs text-muted-foreground max-w-[280px] mx-auto animate-pulse" style={{ color: "var(--text-muted)" }}>
                                Chargement progressif et en temps réel des données pour <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>{nomFournisseur}</span>.
                            </p>
                        </div>

                        {/* Barre de progression dynamique */}
                        <div className="w-full space-y-2">
                            <div className="flex justify-between text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                                <span>Progression</span>
                                <span>
                                    {totalRows 
                                        ? `${Math.round((rowsLoaded / totalRows) * 100)}%` 
                                        : `${rowsLoaded.toLocaleString("fr-FR")} réfs`}
                                </span>
                            </div>
                            <div className="w-full h-2 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800" style={{ border: "1px solid var(--border)" }}>
                                <div 
                                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-300 ease-out rounded-full"
                                    style={{
                                        width: totalRows ? `${(rowsLoaded / totalRows) * 100}%` : "40%",
                                    }}
                                />
                            </div>
                            <p className="text-[11px] font-medium animate-pulse" style={{ color: "var(--text-muted)" }}>
                                {totalRows 
                                    ? `${rowsLoaded.toLocaleString("fr-FR")} sur ${totalRows.toLocaleString("fr-FR")} références chargées`
                                    : `${rowsLoaded.toLocaleString("fr-FR")} références récupérées...`}
                            </p>
                        </div>

                        {/* Boutons d'action */}
                        <div className="w-full pt-2 flex flex-col gap-2">
                            <button
                                onClick={() => setShowStartOverlay(false)}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 active:scale-95 hover:shadow-lg hover:shadow-emerald-500/20 transition-all duration-200"
                            >
                                Explorer les premières données
                            </button>
                            <p className="text-[10px] text-muted italic" style={{ color: "var(--text-muted)" }}>
                                Le chargement continuera en arrière-plan sans bloquer votre navigation.
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
