"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { auth } from "@/lib/auth";
import { and, desc, eq } from "drizzle-orm";

export async function getSnapshots(type?: "snapshot" | "export") {
    try {
        const session = await auth();
        const userId = session?.user ? Number((session.user as any).id) : null;

        let query = db.select().from(sessionSnapshots);
        const conditions = [];
        if (userId) conditions.push(eq(sessionSnapshots.userId, userId));
        if (type) conditions.push(eq(sessionSnapshots.type, type));

        if (conditions.length > 0) {
            return query.where(and(...conditions)).orderBy(desc(sessionSnapshots.createdAt));
        }

        return query.orderBy(desc(sessionSnapshots.createdAt));
    } catch (err: any) {
        const msg = (err?.message || String(err)).split("\n")[0];
        console.error(`[getSnapshots] ERROR (type=${type}):`, msg, err);
        return [];
    }
}
