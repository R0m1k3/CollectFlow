/**
 * CollectFlow — Point d'entrée exécuté une fois au démarrage du serveur.
 *
 * Sert à armer le minuteur de la synchronisation nocturne. L'import est
 * dynamique et conditionné au runtime Node : `register()` est aussi évalué
 * dans le runtime Edge, où ni `setInterval` persistant ni l'accès à la base
 * n'ont de sens.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    try {
        const { startSyncTimer } = await import("@/features/admin/api/sync-timer");
        startSyncTimer();
    } catch (e) {
        // Un démarrage réussi prime sur le planificateur : s'il ne s'arme pas,
        // l'application doit rester utilisable et la synchro manuelle disponible.
        console.error("[instrumentation] minuteur de synchro non démarré :", e instanceof Error ? e.message : String(e));
    }
}
