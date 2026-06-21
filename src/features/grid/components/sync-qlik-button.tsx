"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Loader2, RefreshCw, CheckCircle, AlertCircle } from "lucide-react";

interface SyncQlikButtonProps {
    /** Code fournisseur affiché (pour sync ciblée) */
    codeFournisseur?: string;
    /** Date ISO de dernière maj Qlik pour ce fournisseur (max des lignes) */
    lastUpdate?: string | null;
}

function formatDate(iso?: string | null): string {
    if (!iso) return "jamais";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "jamais";
    return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Bouton admin : synchronise depuis Qlik les métriques réseau du fournisseur affiché
 * (POST /api/qlik/sync?fournisseur=…) puis recharge la grille. Affiche la dernière maj.
 */
export function SyncQlikButton({ codeFournisseur, lastUpdate }: SyncQlikButtonProps) {
    const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
    const [message, setMessage] = useState<string>("");
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const handleSync = async () => {
        if (!codeFournisseur) {
            setStatus("error");
            setMessage("Aucun fournisseur sélectionné");
            return;
        }
        setStatus("loading");
        setMessage("");
        try {
            const res = await fetch(`/api/qlik/sync?fournisseur=${encodeURIComponent(codeFournisseur)}`, { method: "POST" });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
            setStatus("success");
            setMessage(`${data.upserted} produits réseau synchronisés`);
            // Bump _refresh → grid-client refetch /api/grid/rows avec refresh=1 (forceRefresh,
            // bypass cache 10 min de getProductRows) pour afficher les nouvelles métriques réseau.
            const params = new URLSearchParams(searchParams.toString());
            params.set("_refresh", String(Date.now()));
            router.replace(`${pathname}?${params.toString()}`);
            router.refresh();
            setTimeout(() => setStatus("idle"), 4000);
        } catch (e) {
            setStatus("error");
            setMessage(e instanceof Error ? e.message : String(e));
            setTimeout(() => setStatus("idle"), 6000);
        }
    };

    return (
        <div className="flex items-center gap-2">
            <span
                className="text-[10px] leading-tight text-right whitespace-nowrap hidden lg:block"
                style={{ color: status === "error" ? "var(--accent-error)" : "var(--text-muted)" }}
            >
                {status === "error" ? message : `MAJ Qlik · ${formatDate(lastUpdate)}`}
            </span>
            <button
                onClick={handleSync}
                disabled={status === "loading"}
                className="btn-action btn-action-secondary flex items-center gap-1.5 disabled:opacity-60"
                title={message || `Synchroniser les données réseau Qlik · MAJ ${formatDate(lastUpdate)}`}
            >
                {status === "loading" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : status === "success" ? (
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                ) : status === "error" ? (
                    <AlertCircle className="w-3.5 h-3.5 text-rose-500" />
                ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                )}
                Sync Qlik
            </button>
        </div>
    );
}
