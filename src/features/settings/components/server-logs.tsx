"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, FileText, AlertCircle } from "lucide-react";

interface LogEntry {
    id: string;
    octets: number;
    modifieLe: string;
    enCours: boolean;
}

function formatTaille(octets: number): string {
    if (octets < 1024) return `${octets} o`;
    if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
    return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
}

/** Appelle l'API. Volontairement sans état React : réutilisable tel quel. */
async function recupererLogs(): Promise<LogEntry[]> {
    const res = await fetch("/api/logs", { cache: "no-store" });
    if (!res.ok) {
        throw new Error(res.status === 403 ? "Réservé aux administrateurs" : `HTTP ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data.logs) ? data.logs : [];
}

/**
 * Journaux serveur des extractions Qlik — consultation et téléchargement.
 *
 * Une extraction produit plusieurs milliers de lignes de diagnostic. Un
 * terminal les tronque et n'en laisse que la fin, alors que l'information
 * décisive (carte du modèle Qlik, champs retenus, choix des périodes) se trouve
 * en tête. Le journal complet est donc capturé côté serveur et récupérable ici
 * en un fichier.
 */
export function ServerLogs() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    // « chargement » dès le départ : le premier appel part au montage, et aucun
    // setState ne doit être fait de façon synchrone dans un effet.
    const [etat, setEtat] = useState<"idle" | "chargement" | "erreur">("chargement");
    const [erreur, setErreur] = useState<string>("");

    /** Applique un résultat (succès ou échec) à l'état local. */
    const appliquer = useCallback((entrees: LogEntry[] | null, message: string) => {
        if (entrees) {
            setLogs(entrees);
            setErreur("");
            setEtat("idle");
        } else {
            setErreur(message);
            setEtat("erreur");
        }
    }, []);

    // Chargement initial. L'état n'est touché que depuis les callbacks de la
    // promesse, jamais dans le corps de l'effet.
    useEffect(() => {
        recupererLogs()
            .then((entrees) => appliquer(entrees, ""))
            .catch((e: unknown) => appliquer(null, e instanceof Error ? e.message : String(e)));
    }, [appliquer]);

    /** Rechargement explicite (bouton) : là, l'état « chargement » est immédiat. */
    const recharger = useCallback(() => {
        setEtat("chargement");
        recupererLogs()
            .then((entrees) => appliquer(entrees, ""))
            .catch((e: unknown) => appliquer(null, e instanceof Error ? e.message : String(e)));
    }, [appliquer]);

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <p className="text-[12px] text-[var(--text-secondary)]">
                    Journal complet de chaque extraction Qlik (le plus récent en premier).
                    Conservés le temps de la vie du serveur, 20 au maximum.
                </p>
                <button
                    onClick={recharger}
                    disabled={etat === "chargement"}
                    className="btn-action btn-action-secondary flex items-center gap-1.5 shrink-0 disabled:opacity-60"
                >
                    {etat === "chargement"
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <RefreshCw className="w-3.5 h-3.5" />}
                    Actualiser
                </button>
            </div>

            {etat === "erreur" && (
                <div className="flex items-center gap-2 text-[12px] text-[var(--accent-error)]">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{erreur}</span>
                </div>
            )}

            {etat !== "erreur" && logs.length === 0 && (
                <p className="text-[12px] text-[var(--text-muted)]">
                    Aucun journal pour l&apos;instant — lancez une synchronisation Qlik depuis la Grille.
                </p>
            )}

            {logs.length > 0 && (
                <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
                    {logs.map((log) => (
                        <li key={log.id} className="flex items-center gap-3 px-3 py-2">
                            <FileText className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                                        {log.id}
                                    </span>
                                    {log.enCours && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--brand-solid)] text-white shrink-0">
                                            en cours
                                        </span>
                                    )}
                                </div>
                                <span className="text-[11px] text-[var(--text-muted)]">
                                    {formatDate(log.modifieLe)} · {formatTaille(log.octets)}
                                </span>
                            </div>
                            <a
                                href={`/api/logs?id=${encodeURIComponent(log.id)}`}
                                download
                                className="btn-action btn-action-secondary flex items-center gap-1.5 shrink-0"
                            >
                                <Download className="w-3.5 h-3.5" />
                                Télécharger
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
