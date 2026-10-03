"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, FileText } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { fmtDecimal1 } from "@/lib/format";

interface LogEntry {
    id: string;
    octets: number;
    modifieLe: string;
    enCours: boolean;
}

function formatTaille(octets: number): string {
    if (octets < 1024) return `${octets} o`;
    if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
    return `${fmtDecimal1(octets / (1024 * 1024))} Mo`;
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
        <Card>
            <CardHeader
                title="Journal serveur"
                description="Le détail de chaque mise à jour des données du réseau (extraction Qlik), à télécharger pour comprendre une erreur. Les 20 derniers journaux sont conservés jusqu'au prochain redémarrage du serveur ; le plus récent est en premier."
                actions={
                    <Button variant="outline" size="sm" onClick={recharger} disabled={etat === "chargement"}>
                        {etat === "chargement" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        Actualiser
                    </Button>
                }
            />
            <CardContent>
                {etat === "erreur" ? (
                    <ErrorState
                        title="Les journaux n'ont pas pu être chargés"
                        detail={erreur}
                        action={<Button variant="outline" onClick={recharger}>Réessayer</Button>}
                    />
                ) : etat === "chargement" && logs.length === 0 ? (
                    <div className="space-y-2" aria-busy="true" aria-label="Chargement des journaux">
                        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                    </div>
                ) : logs.length === 0 ? (
                    <EmptyState
                        icon={FileText}
                        title="Aucun journal pour l'instant"
                        description="Un journal est créé à chaque mise à jour des données du réseau : lancez-en une depuis la Grille (bouton « Mettre à jour le réseau ») ou attendez la synchronisation nocturne."
                    />
                ) : (
                    <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                        {logs.map((log) => (
                            <li key={log.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                                <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-mono text-sm font-medium text-[var(--text-primary)]">
                                            {log.id}
                                        </span>
                                        {log.enCours && <Badge ton="accent">En cours</Badge>}
                                    </div>
                                    <span className="text-[13px] text-[var(--text-muted)]">
                                        {formatDate(log.modifieLe)} · {formatTaille(log.octets)}
                                    </span>
                                </div>
                                <Button asChild variant="outline" size="sm">
                                    <a href={`/api/logs?id=${encodeURIComponent(log.id)}`} download>
                                        <Download />
                                        Télécharger
                                    </a>
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}
