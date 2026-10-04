"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function getSnapshots(type?: "snapshot" | "export") {
    const utilisateur = await requireSession();
    try {
        const rawUserId = utilisateur.id;
        const userId = rawUserId ? parseInt(rawUserId, 10) : null;

        // Si on a un userId, on filtre par celui-ci.
        // Sinon, on filtre par userId IS NULL (mode anonyme/local)
        const userCondition = userId && !isNaN(userId) 
            ? eq(sessionSnapshots.userId, userId) 
            : isNull(sessionSnapshots.userId);

        const conditions = [userCondition];
        if (type) conditions.push(eq(sessionSnapshots.type, type));

        return await db.select()
            .from(sessionSnapshots)
            .where(and(...conditions))
            .orderBy(desc(sessionSnapshots.createdAt));
    } catch (err) {
        const msg = ((err as Error)?.message || String(err)).split("\n")[0];
        console.error(`[getSnapshots] ERROR (type=${type}):`, msg, err);
        // Remonter l'erreur : une liste vide faisait afficher « Aucun snapshot »
        // au lieu de signaler que le chargement a échoué.
        throw new Error("Chargement de l'historique impossible.");
    }
}
