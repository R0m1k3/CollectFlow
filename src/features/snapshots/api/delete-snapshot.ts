"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth";

export async function deleteSnapshot(id: number) {
    const session = await auth();
    const rawUserId = (session?.user as any)?.id;
    const userId = rawUserId ? parseInt(String(rawUserId), 10) : null;

    console.log(`[deleteSnapshot] Request for ID: ${id}, Session UserId: ${userId}`);

    try {
        // Condition de sécurité : match ID ET match le propriétaire (ou anonyme)
        const userCondition = userId && !isNaN(userId)
            ? eq(sessionSnapshots.userId, userId)
            : isNull(sessionSnapshots.userId);

        const result = await db.delete(sessionSnapshots)
            .where(and(eq(sessionSnapshots.id, id), userCondition))
            .returning({ deletedId: sessionSnapshots.id });
        
        if (result.length === 0) {
            console.warn(`[deleteSnapshot] No rows deleted for ID ${id}. Snapshot may not exist or belongs to another user.`);
            return { success: false, error: "Snapshot non trouvé ou non autorisé" };
        }

        console.log(`[deleteSnapshot] Successfully deleted ID: ${id}`);
        return { success: true };
    } catch (err: any) {
        console.error("[deleteSnapshot] DB Error:", err);
        return { success: false, error: err.message || "Delete failed" };
    }
}
