"use client";

import { useGridStore } from "@/features/grid/store/use-grid-store";
import { Loader2, RefreshCw, CheckCircle, AlertCircle } from "lucide-react";
import { useQlikSyncJob } from "@/features/qlik-sync/use-qlik-sync-job";

interface SyncQlikButtonProps {
    /** Code fournisseur affiché (pour sync ciblée) */
    codeFournisseur?: string;
    /** Date ISO de dernière maj Qlik pour ce fournisseur (max des lignes) */
    lastUpdate?: string | null;
}

/** Date + heure de dernière synchro, ou "jamais". */
function formatLastUpdate(iso?: string | null): string {
    if (!iso) return "jamais";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "jamais";
    return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Bouton admin : synchronise depuis Qlik les métriques réseau du fournisseur affiché
 * (POST /api/qlik/sync?fournisseur=…) puis recharge la grille. Affiche la dernière maj.
 *
 * Toute la mécanique de job (POST puis polling GET, reprise après reload) vit
 * dans `useQlikSyncJob`, partagée avec la fiche produit.
 */
export function SyncQlikButton({ codeFournisseur, lastUpdate }: SyncQlikButtonProps) {
    /** Recharge la grille en ignorant le cache serveur (la barre de résumé suit). */
    const requestRefresh = useGridStore((s) => s.requestRefresh);

    const { status, message, start } = useQlikSyncJob({
        target: { mode: "fournisseur", fournisseur: codeFournisseur },
        onSuccess: requestRefresh,
    });

    return (
        <div className="flex items-center gap-2">
            <span
                className="text-xs leading-tight text-right whitespace-nowrap hidden xl:block"
                style={{ color: status === "error" ? "var(--accent-error)" : "var(--text-muted)" }}
                title={message || undefined}
            >
                {status === "error"
                    ? message
                    : status === "running"
                        ? (message || "Récupération des données réseau…")
                        : lastUpdate
                            ? `Réseau mis à jour le ${formatLastUpdate(lastUpdate)}`
                            : "Réseau jamais mis à jour"}
            </span>
            <button
                onClick={start}
                disabled={status === "running"}
                className="btn-action btn-action-secondary flex items-center gap-1.5 disabled:opacity-60"
                title={message || `Mettre à jour les ventes du réseau (Qlik) pour ce fournisseur — dernière mise à jour : ${formatLastUpdate(lastUpdate)}`}
            >
                {status === "running" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : status === "success" ? (
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                ) : status === "error" ? (
                    <AlertCircle className="w-3.5 h-3.5 text-rose-500" />
                ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                )}
                {status === "running" ? "Mise à jour…" : "Mettre à jour le réseau"}
            </button>
        </div>
    );
}
