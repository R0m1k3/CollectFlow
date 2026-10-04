"use server";

import { getSitesFromApi } from "@/lib/api-ff-client";
import { getFournisseursCached } from "@/lib/ff-cache";
import { requireSession } from "@/lib/authz";

/**
 * Get the list of all suppliers from PostgreSQL (fouadr1).
 */
export async function getFournisseurs() {
    await requireSession();
    // Relu à chaque navigation dans la Grille (changement de fournisseur, de
    // magasin…) : le référentiel ne change qu'avec la recopie nocturne.
    return getFournisseursCached();
}

/**
 * Get the list of all stores (sites) from the FF Nancy API.
 */
export async function getMagasins() {
    await requireSession();
    return getSitesFromApi();
}
