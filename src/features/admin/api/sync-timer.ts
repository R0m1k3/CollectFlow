/**
 * CollectFlow — Minuteur de la synchronisation nocturne.
 *
 * Démarré une fois au boot par `src/instrumentation.ts`. Il bat chaque minute
 * et laisse `tickScheduler()` décider s'il y a quelque chose à faire : hors
 * fenêtre, ou si un round tourne déjà, le battement ne coûte rien.
 *
 * Conséquence assumée du choix « minuteur interne » plutôt que cron système :
 * rien ne tourne si l'application est arrêtée. En contrepartie, aucune
 * configuration côté hôte, et le minuteur se réarme tout seul au redémarrage.
 */

import "server-only";

import { tickScheduler } from "@/features/admin/api/sync-scheduler";

const INTERVALLE_MS = 60_000;

/**
 * Garde au niveau du module : en développement, le rechargement à chaud peut
 * réévaluer `register()` plusieurs fois, et on se retrouverait avec autant de
 * minuteurs empilés.
 */
let minuteur: ReturnType<typeof setInterval> | null = null;

export function startSyncTimer(): void {
    if (minuteur) return;

    console.log(`[sync-nuit] minuteur démarré (battement ${INTERVALLE_MS / 1000} s)`);
    minuteur = setInterval(() => {
        // `tickScheduler` capture déjà ses propres erreurs ; ce `catch` ne couvre
        // qu'un rejet inattendu, pour qu'il ne devienne jamais une exception non
        // gérée capable d'abattre le processus.
        void tickScheduler().catch((e) => {
            console.error("[sync-nuit] battement en erreur :", e instanceof Error ? e.message : String(e));
        });
    }, INTERVALLE_MS);

    // Ne pas maintenir le processus en vie uniquement pour ce minuteur.
    minuteur.unref?.();
}
