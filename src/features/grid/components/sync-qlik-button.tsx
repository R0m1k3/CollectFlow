"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Loader2, RefreshCw, CheckCircle, AlertCircle } from "lucide-react";

interface SyncQlikButtonProps {
    /** Code fournisseur affiché (pour sync ciblée) */
    codeFournisseur?: string;
    /** Date ISO de dernière maj Qlik pour ce fournisseur (max des lignes) */
    lastUpdate?: string | null;
}

/** État serveur renvoyé par GET/POST /api/qlik/sync */
interface SyncJobState {
    jobId: string | null;
    fournisseur: string;
    status: "idle" | "running" | "success" | "error";
    requested: number;
    fetched: number;
    upserted: number;
    periode?: string;
    dateDebut?: string;
    dateFin?: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    message?: string;
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
 *
 * UX : le POST démarre un job serveur en arrière-plan et revient immédiatement.
 * Le composant poll ensuite GET pour suivre l'avancement. Au mount, on appelle
 * GET pour reprendre l'état d'un éventuel job en cours (par ex. après reload de
 * la page) et continuer à afficher le spinner correctement.
 */
export function SyncQlikButton({ codeFournisseur, lastUpdate }: SyncQlikButtonProps) {
    const [status, setStatus] = useState<"idle" | "running" | "success" | "error">("idle");
    const [message, setMessage] = useState<string>("");
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** true tant qu'on doit suivre le job courant (false après succès/erreur traité). */
    const trackingRef = useRef<boolean>(false);

    const clearPollTimer = useCallback(() => {
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    /**
     * Met à jour le label visible à droite du bouton selon l'état courant.
     */
    const applyJobToUi = useCallback((j: SyncJobState | null) => {
        if (!j) return;
        if (j.status === "running") {
            setStatus("running");
            // Texte informatif pendant l'extraction
            const requestedTxt = j.requested > 0 ? ` (${j.requested} codes)` : "";
            setMessage(`Extraction Qlik en cours${requestedTxt}…`);
        } else if (j.status === "success") {
            setStatus("success");
            if (j.message) setMessage(j.message);
            else setMessage(`${j.upserted} produits réseau synchronisés`);
        } else if (j.status === "error") {
            setStatus("error");
            setMessage(j.error || "Erreur sync Qlik");
        } else {
            setStatus("idle");
        }
    }, []);

    /**
     * Force le refresh de la grille (avec cache-buster) et de la barre de résumé.
     * C'est l'équivalent de ce que faisait l'ancien code après un POST réussi.
     */
    const refreshGrid = useCallback(() => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("_refresh", String(Date.now()));
        router.replace(`${pathname}?${params.toString()}`);
        router.refresh();
    }, [pathname, router, searchParams]);

    /**
     * Polling GET pendant qu'un job tourne. S'arrête tout seul quand le job
     * passe en success/error, ou après un timeout de sécurité.
     */
    const pollOnce = useCallback(async (): Promise<boolean> => {
        if (!codeFournisseur) return false;
        if (!trackingRef.current) return false;
        try {
            const res = await fetch(
                `/api/qlik/sync?fournisseur=${encodeURIComponent(codeFournisseur)}`,
                { method: "GET", cache: "no-store" },
            );
            if (!res.ok) {
                // En cas d'erreur HTTP transitoire on retente au tour suivant.
                return true;
            }
            const data: SyncJobState = await res.json();
            applyJobToUi(data);

            if (data.status === "running") {
                // Continue à poller
                return true;
            }
            if (data.status === "success" || data.status === "error") {
                // Terminé : on rafraîchit la grille, on coupe le polling.
                trackingRef.current = false;
                if (data.status === "success") {
                    refreshGrid();
                }
                // Petit délai pour laisser l'utilisateur lire le message vert/rouge
                setTimeout(() => {
                    setStatus((cur) => (cur === "success" || cur === "error" ? "idle" : cur));
                }, 4000);
                return false;
            }
            // idle : rien à faire
            trackingRef.current = false;
            return false;
        } catch {
            // Erreur réseau transitoire, on laisse le polling réessayer.
            return true;
        }
    }, [applyJobToUi, codeFournisseur, refreshGrid]);

    /**
     * Boucle de polling : s'auto-réarme tant que pollOnce indique qu'il faut
     * continuer. Délai un peu plus long que d'habitude (3 s) pour ne pas
     * marteler le serveur pendant une extraction qui dure plusieurs minutes.
     */
    const startPolling = useCallback(() => {
        clearPollTimer();
        const tick = async () => {
            const keepGoing = await pollOnce();
            if (keepGoing && trackingRef.current) {
                pollTimerRef.current = setTimeout(tick, 3000);
            } else {
                pollTimerRef.current = null;
            }
        };
        // Premier appel quasi immédiat
        pollTimerRef.current = setTimeout(tick, 200);
    }, [clearPollTimer, pollOnce]);

    /**
     * Au mount : si on a un fournisseur, on interroge l'API pour savoir si
     * un job tourne déjà (ex. reload de la page pendant l'extraction). Si
     * oui, on reprend l'état et on relance le polling.
     */
    useEffect(() => {
        if (!codeFournisseur) return;
        let cancelled = false;
        trackingRef.current = false;
        clearPollTimer();
        (async () => {
            try {
                const res = await fetch(
                    `/api/qlik/sync?fournisseur=${encodeURIComponent(codeFournisseur)}`,
                    { method: "GET", cache: "no-store" },
                );
                if (cancelled) return;
                if (!res.ok) return;
                const data: SyncJobState = await res.json();
                if (cancelled) return;
                if (data.status === "running" && data.jobId) {
                    trackingRef.current = true;
                    applyJobToUi(data);
                    startPolling();
                } else if (data.status === "success" || data.status === "error") {
                    // Job terminé en amont (avant le mount) : on l'affiche brièvement
                    applyJobToUi(data);
                    setTimeout(() => {
                        setStatus((cur) => (cur === "success" || cur === "error" ? "idle" : cur));
                    }, 4000);
                }
            } catch {
                /* ignore : on n'empêche pas l'UI d'afficher le bouton */
            }
        })();
        return () => {
            cancelled = true;
            trackingRef.current = false;
            clearPollTimer();
        };
        // On veut interroger une seule fois au mount (et quand le fournisseur change).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codeFournisseur, clearPollTimer]);

    /**
     * Cleanup : annule un timer de polling éventuel au démontage.
     */
    useEffect(() => {
        return () => {
            clearPollTimer();
        };
    }, [clearPollTimer]);

    const handleSync = async () => {
        if (!codeFournisseur) {
            setStatus("error");
            setMessage("Aucun fournisseur sélectionné");
            setTimeout(() => setStatus("idle"), 6000);
            return;
        }
        // Empêche un double-clic pendant qu'un job tourne déjà.
        if (status === "running") return;

        setStatus("running");
        setMessage("Démarrage de l'extraction Qlik…");
        try {
            const res = await fetch(
                `/api/qlik/sync?fournisseur=${encodeURIComponent(codeFournisseur)}`,
                { method: "POST" },
            );
            const data: SyncJobState & { success?: boolean } = await res.json();
            if (!res.ok || (data as { success?: boolean }).success === false) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            // Si le serveur nous dit que c'est déjà en cours (jobId existant),
            // on reprend juste le suivi.
            if (data.status === "running" && data.jobId) {
                trackingRef.current = true;
                applyJobToUi(data);
                startPolling();
                return;
            }
            // Status terminal direct (cas rare : 0 codes → success immédiat)
            applyJobToUi(data);
            if (data.status === "success") {
                refreshGrid();
            }
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
                title={message || undefined}
            >
                {status === "error"
                    ? message
                    : status === "running"
                        ? (message || `Extraction Qlik…`)
                        : `MAJ Qlik · ${formatDate(lastUpdate)}`}
            </span>
            <button
                onClick={handleSync}
                disabled={status === "running"}
                className="btn-action btn-action-secondary flex items-center gap-1.5 disabled:opacity-60"
                title={message || `Synchroniser les données réseau Qlik · MAJ ${formatDate(lastUpdate)}`}
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
                {status === "running" ? "Sync en cours…" : "Sync Qlik"}
            </button>
        </div>
    );
}
