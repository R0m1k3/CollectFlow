/**
 * Enregistrement d'une session de révision ou d'un export — action exécutée par
 * le serveur Rust : `POST /api/actions/saveSnapshot` (validation des données
 * comprise).
 */

import { callAction } from "@/lib/rpc";

/** Données attendues par le serveur (ex-schéma zod `SaveSnapshotSchema`). */
export interface SaveSnapshotInput {
    codeFournisseur: string;
    nomFournisseur?: string;
    magasin: string;
    label?: string;
    changes: Record<string, { before: string | null; after: string }>;
    type?: "snapshot" | "export";
    summary?: {
        totalRows: number;
        /** CA HT : base de tauxMargeGlobal. */
        totalCa: number;
        /** CA TTC affiché. */
        totalCaTtc?: number;
        totalMarge: number;
        tauxMargeGlobal: number;
    };
}

export async function saveSnapshot(raw: unknown): Promise<{ success: boolean; snapshotId?: number; error?: string }> {
    return callAction("saveSnapshot", [raw]);
}
