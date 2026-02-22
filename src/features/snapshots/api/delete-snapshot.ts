"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";

export async function deleteSnapshot(id: number) {
    const session = await auth();
    const userId = session?.user ? Number((session.user as any).id) : null;

    if (!userId) {
        return { success: false, error: "Non autorisé" };
    }

    try {
        await db.delete(sessionSnapshots)
            .where(and(eq(sessionSnapshots.id, id), eq(sessionSnapshots.userId, userId)));
        return { success: true };
    } catch (err) {
        console.error(err);
        return { success: false, error: "Delete failed" };
    }
}
