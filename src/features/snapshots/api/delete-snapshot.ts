"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";

export async function deleteSnapshot(id: number) {
    const session = await auth();
    const rawUserId = (session?.user as any)?.id;
    const userId = rawUserId ? parseInt(String(rawUserId), 10) : null;

    console.log(`[deleteSnapshot] Request for ID: ${id}, Session UserId: ${userId} (raw: ${rawUserId})`);

    if (!userId || isNaN(userId)) {
        console.error("[deleteSnapshot] Unauthorized: userId is missing or invalid");
        return { success: false, error: "Non autorisé" };
    }

    try {
        const result = await db.delete(sessionSnapshots)
            .where(and(eq(sessionSnapshots.id, id), eq(sessionSnapshots.userId, userId)))
            .returning({ deletedId: sessionSnapshots.id });
        
        if (result.length === 0) {
            console.warn(`[deleteSnapshot] No rows deleted for ID ${id} and User ${userId}. Maybe the snapshot doesn't belong to the user?`);
            // We return success: false to trigger the error modal in UI if nothing was actually deleted
            return { success: false, error: "Élément non trouvé ou non autorisé" };
        }

        console.log(`[deleteSnapshot] Successfully deleted ID: ${id}`);
        return { success: true };
    } catch (err: any) {
        console.error("[deleteSnapshot] DB Error:", err);
        return { success: false, error: err.message || "Delete failed" };
    }
}
