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
import { Loader2, Play, CheckCircle2, AlertTriangle, Database } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/feedback";
import { fmtEntier } from "@/lib/format";

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
    const [demarrage, setDemarrage] = useState(false);
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
        setDemarrage(true);
        let echec: string | null = null;
        try {
            const res = await fetch("/api/admin/grid-warmup?staleHours=24", { method: "POST" });
            const data = await res.json();
            if (res.ok) setState(data);
            else echec = data.error ?? `erreur ${res.status}`;
        } catch (e) {
            echec = e instanceof Error ? e.message : String(e);
        }
        setDemarrage(false);
        if (echec) toast.erreur(`Le préchauffage n'a pas pu démarrer : ${echec}`);
    };

    const traites = (state?.done ?? 0) + (state?.skipped ?? 0) + (state?.failed ?? 0);
    const pct = state && state.total > 0 ? Math.round((traites / state.total) * 100) : 0;

    return (
        <Card>
            <CardHeader
                title="Préchauffage des données de l'API"
                description="Préchauffage : calcule à l'avance les grilles de tous les fournisseurs pour que l'API réponde immédiatement."
            />
            <CardContent className="space-y-4">
                <p className="text-sm text-[var(--text-secondary)]">
                    L&apos;API lit les grilles déjà calculées, enregistrées quand un fournisseur est ouvert dans la Grille.
                    Sans préchauffage, un outil externe ne trouverait tout de suite que les fournisseurs déjà consultés.
                    Les fournisseurs calculés il y a moins de 24 h sont sautés : vous pouvez relancer sans risque.
                </p>

                <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={start} disabled={running || demarrage}>
                        {running || demarrage ? <Loader2 className="animate-spin" /> : <Play />}
                        {running ? "Préparation en cours…" : "Préparer les données pour l'API"}
                    </Button>
                    {state && state.total > 0 && (
                        <span className="text-[13px] tabular-nums text-[var(--text-secondary)]">
                            {fmtEntier(traites)} fournisseurs sur {fmtEntier(state.total)} ({pct} %)
                        </span>
                    )}
                </div>

                {running && state && (
                    <div className="space-y-1.5">
                        <div
                            className="h-2 overflow-hidden rounded-full bg-[var(--bg-elevated)]"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct}
                            aria-label="Avancement du préchauffage"
                        >
                            <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        {state.currentFournisseur && (
                            <p className="truncate text-[13px] text-[var(--text-muted)]">
                                En cours : {state.currentFournisseur}
                            </p>
                        )}
                    </div>
                )}

                {state?.status === "success" && (
                    <p className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-success)]" aria-hidden />
                        <span>
                            Terminé : <strong className="text-[var(--text-primary)]">{fmtEntier(state.done)}</strong> fournisseur(s) calculé(s),{" "}
                            <strong className="text-[var(--text-primary)]">{fmtEntier(state.skipped)}</strong> déjà à jour
                            {state.failed > 0 && <>, <strong className="text-[var(--accent-error)]">{fmtEntier(state.failed)} en échec</strong></>}.
                        </span>
                    </p>
                )}

                {state && state.failed > 0 && state.lastErrors.length > 0 && (
                    <details className="text-[13px] text-[var(--text-secondary)]">
                        <summary className="cursor-pointer font-medium">Voir les échecs ({state.lastErrors.length} premiers)</summary>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                            {state.lastErrors.map((e, i) => <li key={i} className="break-all font-mono">{e}</li>)}
                        </ul>
                    </details>
                )}

                {state?.error && (
                    <p role="alert" className="flex items-start gap-2 text-sm text-[var(--accent-error)]">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span>{state.error}</span>
                    </p>
                )}

                {state?.status === "idle" && (
                    <p className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
                        <Database className="h-4 w-4" aria-hidden />
                        Aucun préchauffage lancé depuis le démarrage de l&apos;application.
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
