/**
 * Suppression d'un enregistrement de l'historique — action exécutée par le
 * serveur Rust : `POST /api/actions/deleteSnapshot`.
 */

import { callAction } from "@/lib/rpc";

export async function deleteSnapshot(id: number): Promise<{ success: boolean; error?: string }> {
    return callAction("deleteSnapshot", [id]);
}
