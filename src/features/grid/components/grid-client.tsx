"use client";

import { useEffect, useRef, useState } from "react";
import { HeatmapGrid } from "@/features/grid/components/heatmap-grid";
import { FloatingSummaryBar } from "@/features/grid/components/floating-summary-bar";
import { BulkActionToolbar } from "@/features/grid/components/bulk-action-toolbar";
import { GridFilterBar } from "@/features/grid/components/grid-filter-bar";
import { rowsKeyFor, useGridStore } from "@/features/grid/store/use-grid-store";
import { useStorePatch } from "@/features/grid/hooks/use-store-patch";
import type { ProductRow } from "@/types/grid";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { nomMagasin } from "@/lib/magasins";

import { useSearchParams } from "next/navigation";
import type { GridFilters } from "@/types/grid";

interface GridClientProps {
    codeFournisseur: string;
    nomFournisseur: string;
    fournisseurs: { code: string; nom: string }[];
    magasins: { code: string; nom: string }[];
    magasin: string;
    filters: Pick<GridFilters, "code1" | "code2" | "code3">;
    /** Calculé côté serveur : les droits ne changent plus d'un rendu à l'autre. */
    isAdmin: boolean;
}

type GridRowsStreamMessage =
    | { type: "start"; loaded: number; total: null }
    | { type: "chunk"; rows: ProductRow[]; loaded: number; total: number }
    | { type: "done"; loaded: number; total: number }
    | { type: "error"; error: string };

/** Petite pastille métrique (libellé + valeur) — densité pro, thème Slate/teal. */
function MetricPill({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
    return (
        <div
            className="flex flex-col items-start px-3 py-1.5 rounded-lg shrink-0"
            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
        >
            <span className="text-xs leading-none mb-1" style={{ color: "var(--text-muted)" }}>
                {label}
            </span>
            <span
                className="text-sm font-semibold leading-none tabular-nums max-w-[180px] truncate"
                style={{ color: accent ? "var(--accent)" : "var(--text-primary)" }}
                title={value}
            >
                {value}
            </span>
        </div>
    );
}

export function GridClient({ codeFournisseur, nomFournisseur, fournisseurs, magasins, magasin, isAdmin }: GridClientProps) {
    const setRows = useGridStore((s) => s.setRows);
    // Seul le nombre de lignes sert ici : un abonnement au tableau entier
    // redessinait toute la page à chaque modification de gamme.
    const nbRows = useGridStore((s) => s.rows.length);
    const setActiveGridQuery = useGridStore((s) => s.setActiveGridQuery);
    const setFilter = useGridStore((s) => s.setFilter);
    const setCode3Filter = useGridStore((s) => s.setCode3Filter);
    const setActiveMagasin = useGridStore((s) => s.setActiveMagasin);
    const activeMagasin = useGridStore((s) => s.activeMagasin);
    const searchParams = useSearchParams();

    const [selectedCodeins, setSelectedCodeins] = useState<string[]>([]);
    const [isLoadingRows, setIsLoadingRows] = useState(false);
    const [rowsLoaded, setRowsLoaded] = useState(0);
    const [totalRows, setTotalRows] = useState<number | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

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
            setCode3Filter(null);
            prevFournisseurRef.current = codeFournisseur;
        }
    }, [codeFournisseur, setFilter, setCode3Filter, isMounted]);

    // Rechargement forcé (bouton « Rafraîchir », fin de synchro Qlik) : demandé via
    // le store, pas via l'URL. On retient la dernière demande déjà servie pour ne
    // pas re-forcer le recalcul serveur à chaque remontage ou changement de filtre.
    const refreshRequest = useGridStore((s) => s.refreshRequest);
    const requestRefresh = useGridStore((s) => s.requestRefresh);
    const servedRefreshRef = useRef(refreshRequest);

    useEffect(() => {
        if (!isMounted) return;

        const controller = new AbortController();
        const params = new URLSearchParams();
        params.set("fournisseur", codeFournisseur);
        // Toujours « tous magasins » : les lignes portent le détail de chaque
        // magasin, le changement de magasin se fait donc sans rien recharger
        // (les compléments de l'API FF arrivent à part, cf. useStorePatch).
        params.set("magasin", "TOTAL");
        // Les filtres de nomenclature (code1/code2/code3) ne sont pas transmis : le
        // serveur ne s'en sert pas et la Grille les applique en local. Les faire
        // voyager relançait un chargement complet à chaque changement.
        const forceRefresh = refreshRequest !== servedRefreshRef.current;
        if (forceRefresh) params.set("refresh", "1");

        const cle = rowsKeyFor(codeFournisseur);
        const { rowsMeta, rows: lignesEnMemoire, setRowsMeta } = useGridStore.getState();

        // Retour sur la Grille (même fournisseur, chargée il y a moins de 10 min) :
        // les lignes sont encore en mémoire, rien à retélécharger.
        if (!forceRefresh && rowsMeta?.key === cle && lignesEnMemoire.length > 0
            && Date.now() - rowsMeta.loadedAt < 10 * 60 * 1000) {
            setRowsLoaded(lignesEnMemoire.length);
            setTotalRows(lignesEnMemoire.length);
            setIsLoadingRows(false);
            return;
        }

        // « Actualiser » (ou lignes de plus de 10 min) sur le même fournisseur : la
        // Grille reste affichée, et les nouvelles lignes la remplacent d'un bloc.
        const memeFournisseur = rowsMeta?.key === cle && lignesEnMemoire.length > 0;

        const accumulatedRows: ProductRow[] = [];
        let lastFlush = 0;
        if (!memeFournisseur) {
            setRows([]);
            // Les lignes vont être remplacées : tant que ce chargement n'est pas
            // terminé, elles ne correspondent plus à aucune clé.
            setRowsMeta(null);
        }
        setRowsLoaded(0);
        setTotalRows(null);
        setLoadError(null);
        setIsLoadingRows(true);

        // Chaque mise à jour du store reconstruit tout le tableau (index, tri,
        // filtres, compteurs) : la faire à chaque paquet de 150 lignes rendait le
        // chargement quadratique. On regroupe donc les paquets et on ne pousse les
        // lignes que toutes les FLUSH_MS (et une dernière fois à la fin).
        const FLUSH_MS = 300;
        // Les lignes déjà poussées dans le store ne doivent plus bouger : on lui
        // passe une copie, et on continue d'accumuler dans le tableau privé.
        const flush = (loaded: number, total: number | null, final = false) => {
            setRowsLoaded(loaded);
            setTotalRows(total);
            lastFlush = Date.now();
            // Même fournisseur : on garde les lignes affichées jusqu'au bout.
            if (memeFournisseur && !final) return;
            setRows(final ? accumulatedRows : accumulatedRows.slice());
        };

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
                let loaded = 0;
                let total: number | null = null;
                let pending = false;

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
                            for (const row of message.rows) accumulatedRows.push(row);
                            loaded = message.loaded;
                            total = message.total;
                            pending = true;
                        } else if (message.type === "done") {
                            loaded = message.loaded;
                            total = message.total;
                        } else if (message.type === "error") {
                            throw new Error(message.error);
                        }
                    }

                    if (pending && Date.now() - lastFlush >= FLUSH_MS) {
                        flush(loaded, total);
                        pending = false;
                    }
                }

                flush(loaded, total, true);
                setRowsMeta({ key: cle, loadedAt: Date.now(), patchedStores: [] });
                if (forceRefresh) servedRefreshRef.current = refreshRequest;
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
    }, [codeFournisseur, refreshRequest, setRows, isMounted]);

    // Compléments de l'API FF pour le magasin choisi, appliqués à leur arrivée.
    useStorePatch(codeFournisseur, isMounted);

    // Magasin initial (ou porté par un lien) : la prop vient de l'URL. Les
    // changements suivants passent par le store et ne re-rendent pas la page.
    useEffect(() => {
        if (!isMounted) return;
        setActiveMagasin(magasin || "TOTAL");
    }, [magasin, setActiveMagasin, isMounted]);

    // Force le rechargement des données depuis le serveur en ignorant le cache
    // 10 min (`refresh=1` → forceRefresh) et remonte l'état serveur à jour (INIT).
    const handleForceRefresh = () => {
        if (isLoadingRows) return;
        requestRefresh();
    };

    if (!isMounted) {
        return <div className="p-8 text-center text-sm text-[var(--text-secondary)]">Préparation de la grille…</div>;
    }

    const nbReferences = totalRows ?? nbRows;
    const progression = totalRows ? Math.round((rowsLoaded / totalRows) * 100) : null;

    return (
        <div className="flex flex-col h-full space-y-3 min-h-0">
            <header className="shrink-0 flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--border)]">
                <div className="flex items-center gap-4 min-w-0">
                    <div className="min-w-0">
                        <p className="text-[13px] text-[var(--text-secondary)]">Révision d&apos;assortiment</p>
                        <h1 className="text-xl font-bold tracking-tight truncate text-[var(--text-primary)]" title={nomFournisseur}>
                            {nomFournisseur}
                        </h1>
                    </div>
                    <div className="hidden md:flex items-center gap-2 pl-4 shrink-0 border-l border-[var(--border)]">
                        <MetricPill label="Magasin" value={nomMagasin(activeMagasin)} />
                        <MetricPill label="Produits" value={nbReferences.toLocaleString("fr-FR")} accent />
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {loadError && (
                        <span className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium border-[var(--accent-error)] bg-[var(--accent-error-bg)] text-[var(--accent-error)]">
                            <AlertCircle className="h-4 w-4" /> {loadError}
                        </span>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleForceRefresh}
                        disabled={isLoadingRows}
                        title="Recharger les données depuis le serveur (gammes FF à jour comprises)"
                    >
                        <RefreshCw className={isLoadingRows ? "animate-spin" : undefined} />
                        Actualiser
                    </Button>
                    <div id="grid-toolbar-actions"></div>
                </div>
            </header>

            {/* Chargement : bandeau discret, la grille reste utilisable. */}
            {isLoadingRows && (
                <div
                    role="status"
                    className="shrink-0 rounded-lg border px-4 py-2 border-[var(--accent-border)] bg-[var(--accent-bg)]"
                >
                    <div className="flex items-center justify-between gap-3 text-[13px] text-[var(--text-primary)]">
                        <span className="flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                            {nbRows > 0
                                ? "Mise à jour des chiffres… la grille reste utilisable."
                                : `Chargement des produits de ${nomFournisseur}…`}
                        </span>
                        <span className="tabular-nums text-[var(--text-secondary)]">
                            {totalRows
                                ? `${rowsLoaded.toLocaleString("fr-FR")} sur ${totalRows.toLocaleString("fr-FR")}`
                                : "Calcul en cours sur le serveur"}
                        </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                        <div
                            className={progression == null ? "h-full w-1/3 animate-pulse rounded-full bg-[var(--accent)]" : "h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"}
                            style={progression == null ? undefined : { width: `${progression}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Filters */}
            <div className="shrink-0 print:hidden">
                <GridFilterBar fournisseurs={fournisseurs} magasins={magasins} />
            </div>

            {/* Bulk toolbar (contextual) */}
            <div className="shrink-0 print:hidden">
                <BulkActionToolbar
                    selectedCodeins={selectedCodeins}
                    onClearSelection={() => setSelectedCodeins([])}
                />
            </div>

            {/* Main content */}
            <div className="flex-1 min-h-0 min-w-0">
                <HeatmapGrid
                    codeFournisseur={codeFournisseur}
                    onSelectionChange={setSelectedCodeins}
                    isAdmin={isAdmin}
                    nomFournisseur={nomFournisseur}
                />
            </div>

            {/* Summary bar */}
            <div className="print:hidden">
                <FloatingSummaryBar isAdmin={isAdmin} nomFournisseur={nomFournisseur} />
            </div>
        </div>
    );
}
