"use client";

/**
 * CollectFlow — Préchauffage des données exposées par l'API.
 *
 * L'API `/api/v1` ne calcule jamais : elle lit un instantané écrit quand la Grille est
 * ouverte dans l'application. Sans ce préchauffage, une IA externe ne verrait que les
 * fournisseurs déjà consultés à la main — d'où ce bouton, qui calcule tout le catalogue
 * une bonne fois.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, CheckCircle, AlertTriangle, Database } from "lucide-react";

interface WarmupState {
    status: "idle" | "running" | "success" | "error";
    total: number;
    done: number;
    skipped: number;
    failed: number;
    currentFournisseur?: string;
    finishedAt?: string;
    error?: string;
    lastErrors: string[];
}

export function GridWarmup() {
    const [state, setState] = useState<WarmupState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const running = state?.status === "running";

    const fetchState = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/grid-warmup");
            if (res.ok) setState(await res.json());
        } catch {
            // Réseau instable : on retentera au tick suivant.
        }
    }, []);

    // Récupère l'état au montage : un préchauffage peut déjà tourner.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchState(); }, [fetchState]);

    // Suivi de l'avancement tant que le job tourne.
    useEffect(() => {
        if (!running) return;
        let cancelled = false;
        const tick = async () => {
            await fetchState();
            if (!cancelled) pollRef.current = setTimeout(tick, 2000);
        };
        pollRef.current = setTimeout(tick, 2000);
        return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
    }, [running, fetchState]);

    const start = async () => {
        setError(null);
        try {
            const res = await fetch("/api/admin/grid-warmup?staleHours=24", { method: "POST" });
            const data = await res.json();
            if (!res.ok) { setError(data.error ?? `Erreur ${res.status}`); return; }
            setState(data);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const traites = (state?.done ?? 0) + (state?.skipped ?? 0) + (state?.failed ?? 0);
    const pct = state && state.total > 0 ? Math.round((traites / state.total) * 100) : 0;

    return (
        <div className="space-y-3">
            <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                L&apos;API ne recalcule jamais : elle lit un instantané écrit quand la Grille est ouverte dans
                l&apos;application. Sans préchauffage, une IA externe ne verrait que les fournisseurs déjà consultés.
                Ce bouton calcule <strong>tous les fournisseurs</strong> ; ceux déjà à jour depuis moins de 24 h sont
                sautés, il est donc sans risque de le relancer.
            </p>

            <div className="flex items-center gap-2.5">
                <button
                    onClick={start}
                    disabled={running}
                    className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50 flex items-center gap-1.5"
                    style={{ background: "var(--accent)" }}
                >
                    {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    {running ? "Préparation en cours…" : "Préparer les données pour l'API"}
                </button>
                {state && state.total > 0 && (
                    <span className="text-[12px] tabular-nums" style={{ color: "var(--text-secondary)" }}>
                        {traites} / {state.total} ({pct} %)
                    </span>
                )}
            </div>

            {running && state && (
                <div className="space-y-1.5">
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-elevated)" }}>
                        <div className="h-full transition-all" style={{ width: `${pct}%`, background: "var(--accent)" }} />
                    </div>
                    {state.currentFournisseur && (
                        <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                            En cours : {state.currentFournisseur}
                        </p>
                    )}
                </div>
            )}

            {state?.status === "success" && (
                <div className="flex items-start gap-2 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                    <CheckCircle className="w-4 h-4 shrink-0 mt-px text-emerald-500" />
                    <span>
                        Terminé : <strong>{state.done}</strong> fournisseur(s) calculé(s),{" "}
                        <strong>{state.skipped}</strong> déjà à jour
                        {state.failed > 0 && <>, <strong style={{ color: "var(--accent-error)" }}>{state.failed} en échec</strong></>}.
                    </span>
                </div>
            )}

            {state && state.failed > 0 && state.lastErrors.length > 0 && (
                <details className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    <summary className="cursor-pointer">Voir les échecs ({state.lastErrors.length} premiers)</summary>
                    <ul className="mt-1 pl-4 list-disc space-y-0.5">
                        {state.lastErrors.map((e, i) => <li key={i} className="break-all">{e}</li>)}
                    </ul>
                </details>
            )}

            {(error || state?.error) && (
                <div className="flex items-start gap-2 text-[12px]" style={{ color: "var(--accent-error)" }}>
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{error ?? state?.error}</span>
                </div>
            )}

            {state?.status === "idle" && (
                <p className="text-[11px] flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                    <Database className="w-3.5 h-3.5" />
                    Aucun préchauffage lancé depuis le démarrage de l&apos;application.
                </p>
            )}
        </div>
    );
}
