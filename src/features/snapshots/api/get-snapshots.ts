"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { auth } from "@/lib/auth";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function getSnapshots(type?: "snapshot" | "export") {
    try {
        const session = await auth();
        const rawUserId = (session?.user as any)?.id;
        const userId = rawUserId ? parseInt(String(rawUserId), 10) : null;

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
    } catch (err: any) {
        const msg = (err?.message || String(err)).split("\n")[0];
        console.error(`[getSnapshots] ERROR (type=${type}):`, msg, err);
        return [];
    }
}
