/**
 * Historique des sessions de révision et des exports — action exécutée par le
 * serveur Rust : `POST /api/actions/getSnapshots`.
 */

import { callAction } from "@/lib/rpc";

/** Une ligne de `session_snapshots`, telle que le serveur la renvoie. */
export interface SnapshotRow {
    id: number;
    userId: number | null;
    codeFournisseur: string;
    nomFournisseur: string | null;
    magasin: string;
    /** codein → { before, after } */
    changes: unknown;
    summaryJson: unknown;
    label: string | null;
    type: string | null;
    /** Date ISO de création. */
    createdAt: string | null;
}

export async function getSnapshots(type?: "snapshot" | "export"): Promise<SnapshotRow[]> {
    return callAction("getSnapshots", [type]);
}
