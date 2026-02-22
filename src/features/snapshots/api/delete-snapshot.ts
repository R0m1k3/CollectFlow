"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function deleteSnapshot(id: number) {
    try {
        await db.delete(sessionSnapshots).where(eq(sessionSnapshots.id, id));
        return { success: true };
    } catch (err) {
        console.error(err);
        return { success: false, error: "Delete failed" };
    }
}
