/**
 * Actions de la Grille (ex-« server actions » Next.js), exécutées par le
 * serveur Rust : `POST /api/actions/{nom}`.
 */

import { callAction } from "@/lib/rpc";

/**
 * Get the list of all suppliers from PostgreSQL (fouadr1).
 */
export async function getFournisseurs(): Promise<{ code: string; nom: string }[]> {
    return callAction("getFournisseurs", []);
}

/**
 * Get the list of all stores (sites) from the FF Nancy API.
 */
export async function getMagasins(): Promise<{ code: string; nom: string }[]> {
    return callAction("getMagasins", []);
}
