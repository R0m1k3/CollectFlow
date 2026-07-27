"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** État serveur renvoyé par GET/POST /api/qlik/sync. */
export interface QlikSyncJobState {
    jobId: string | null;
    fournisseur: string;
    codeCentrale?: string;
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

export type QlikSyncStatus = QlikSyncJobState["status"];

/**
 * Cible de la synchro : un fournisseur entier (réservé aux admins) ou un seul
 * code centrale (ouvert à tout utilisateur connecté).
 */
export type QlikSyncTarget =
    | { mode: "fournisseur"; fournisseur: string | undefined }
    | { mode: "produit"; codeCentrale: string | undefined };

interface UseQlikSyncJobOptions {
    target: QlikSyncTarget;
    /** Appelé une fois quand un job se termine avec succès. */
    onSuccess?: () => void;
    /** Intervalle de polling en ms (défaut 3 s — une extraction peut durer plusieurs minutes). */
    pollIntervalMs?: number;
}

/** Construit la query string de la route selon la cible. */
function targetQuery(target: QlikSyncTarget): string | null {
    if (target.mode === "fournisseur") {
        return target.fournisseur ? `fournisseur=${encodeURIComponent(target.fournisseur)}` : null;
    }
    return target.codeCentrale ? `codeCentrale=${encodeURIComponent(target.codeCentrale)}` : null;
}

/**
 * Pilote un job de synchronisation Qlik : démarrage (POST), suivi (polling GET),
 * reprise d'un job déjà en cours au montage, et nettoyage des timers.
 *
 * Extrait de `SyncQlikButton` pour être partagé avec la fiche produit. Le
 * protocole est inchangé : le POST démarre un job serveur en arrière-plan et
 * revient immédiatement, le client poll ensuite GET jusqu'à l'état terminal.
 */
export function useQlikSyncJob({ target, onSuccess, pollIntervalMs = 3000 }: UseQlikSyncJobOptions) {
    const [status, setStatus] = useState<QlikSyncStatus>("idle");
    const [message, setMessage] = useState<string>("");

    const query = targetQuery(target);
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** true tant qu'on doit suivre le job courant (false après succès/erreur traité). */
    const trackingRef = useRef<boolean>(false);
    // Gardé dans une ref : le callback peut changer d'identité à chaque rendu
    // sans qu'on veuille relancer le polling pour autant.
    const onSuccessRef = useRef(onSuccess);
    useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);

    const clearPollTimer = useCallback(() => {
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    /** Met à jour le libellé visible selon l'état courant. */
    const applyJobToUi = useCallback((j: QlikSyncJobState | null) => {
        if (!j) return;
        if (j.status === "running") {
            setStatus("running");
            const requestedTxt = j.requested > 0 ? ` (${j.requested} code${j.requested > 1 ? "s" : ""})` : "";
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
     * Un tour de polling. Renvoie true s'il faut continuer.
     */
    const pollOnce = useCallback(async (): Promise<boolean> => {
        if (!query || !trackingRef.current) return false;
        try {
            const res = await fetch(`/api/qlik/sync?${query}`, { method: "GET", cache: "no-store" });
            if (!res.ok) {
                // Erreur HTTP transitoire : on retente au tour suivant.
                return true;
            }
            const data: QlikSyncJobState = await res.json();
            applyJobToUi(data);

            if (data.status === "running") return true;

            if (data.status === "success" || data.status === "error") {
                trackingRef.current = false;
                if (data.status === "success") onSuccessRef.current?.();
                // Petit délai pour laisser l'utilisateur lire le message vert/rouge.
                setTimeout(() => {
                    setStatus((cur) => (cur === "success" || cur === "error" ? "idle" : cur));
                }, 4000);
                return false;
            }
            trackingRef.current = false;
            return false;
        } catch {
            // Erreur réseau transitoire : on laisse le polling réessayer.
            return true;
        }
    }, [applyJobToUi, query]);

    /** Boucle de polling auto-réarmée tant que pollOnce le demande. */
    const startPolling = useCallback(() => {
        clearPollTimer();
        const tick = async () => {
            const keepGoing = await pollOnce();
            if (keepGoing && trackingRef.current) {
                pollTimerRef.current = setTimeout(tick, pollIntervalMs);
            } else {
                pollTimerRef.current = null;
            }
        };
        // Premier appel quasi immédiat.
        pollTimerRef.current = setTimeout(tick, 200);
    }, [clearPollTimer, pollOnce, pollIntervalMs]);

    /**
     * Au montage (et quand la cible change) : reprend l'état d'un éventuel job
     * déjà en cours, par exemple après un reload pendant l'extraction.
     */
    useEffect(() => {
        if (!query) return;
        let cancelled = false;
        trackingRef.current = false;
        clearPollTimer();
        (async () => {
            try {
                const res = await fetch(`/api/qlik/sync?${query}`, { method: "GET", cache: "no-store" });
                if (cancelled || !res.ok) return;
                const data: QlikSyncJobState = await res.json();
                if (cancelled) return;
                if (data.status === "running" && data.jobId) {
                    trackingRef.current = true;
                    applyJobToUi(data);
                    startPolling();
                } else if (data.status === "success" || data.status === "error") {
                    // Job terminé avant le montage : on l'affiche brièvement.
                    applyJobToUi(data);
                    setTimeout(() => {
                        setStatus((cur) => (cur === "success" || cur === "error" ? "idle" : cur));
                    }, 4000);
                }
            } catch {
                /* ignore : on n'empêche pas l'UI de s'afficher */
            }
        })();
        return () => {
            cancelled = true;
            trackingRef.current = false;
            clearPollTimer();
        };
        // On veut interroger une seule fois au montage (et quand la cible change).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, clearPollTimer]);

    /** Cleanup : annule un timer de polling éventuel au démontage. */
    useEffect(() => clearPollTimer, [clearPollTimer]);

    /** Démarre l'extraction. */
    const start = useCallback(async () => {
        if (!query) {
            setStatus("error");
            setMessage(target.mode === "fournisseur" ? "Aucun fournisseur sélectionné" : "Aucun code centrale");
            setTimeout(() => setStatus("idle"), 6000);
            return;
        }
        // Empêche un double-clic pendant qu'un job tourne déjà.
        if (status === "running") return;

        setStatus("running");
        setMessage("Démarrage de l'extraction Qlik…");
        try {
            const res = await fetch(`/api/qlik/sync?${query}`, { method: "POST" });
            const data: QlikSyncJobState & { success?: boolean } = await res.json();
            if (!res.ok || data.success === false) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            if (data.status === "running" && data.jobId) {
                trackingRef.current = true;
                applyJobToUi(data);
                startPolling();
                return;
            }
            // Statut terminal direct (cas rare : 0 code → success immédiat).
            applyJobToUi(data);
            if (data.status === "success") onSuccessRef.current?.();
            setTimeout(() => setStatus("idle"), 4000);
        } catch (e) {
            setStatus("error");
            setMessage(e instanceof Error ? e.message : String(e));
            setTimeout(() => setStatus("idle"), 6000);
        }
    }, [applyJobToUi, query, startPolling, status, target.mode]);

    return { status, message, start };
}
