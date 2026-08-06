/**
 * CollectFlow — Détection des Server Actions périmées après un déploiement.
 *
 * Next.js identifie chaque Server Action par un hash calculé **à la compilation**.
 * Après un nouveau build (déploiement, redémarrage du conteneur), les hashs
 * changent : un onglet resté ouvert continue d'envoyer les anciens identifiants,
 * et le serveur répond
 *
 *   Server Action "4010b9…" was not found on the server.
 *
 * Ce n'est pas une panne applicative : c'est le client qui est périmé. La seule
 * issue est de recharger la page pour récupérer le bundle courant.
 *
 * Les brouillons de la Grille sont persistés dans le store zustand
 * (localStorage) : recharger ne perd pas le travail en cours.
 */

/** Message affiché à l'utilisateur quand son onglet est périmé. */
export const STALE_ACTION_MESSAGE =
    "L'application a été mise à jour depuis l'ouverture de cet onglet. Rechargez la page pour continuer — vos modifications en cours sont conservées.";

/** true si l'erreur vient d'une Server Action absente du serveur (bundle périmé). */
export function isStaleServerActionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? "");
    return /server action/i.test(message) && /not\s+be?\s*found|was not found|failed-to-find-server-action/i.test(message);
}
