"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export async function getSnapshots(type?: "snapshot" | "export") {
    let query = db.select().from(sessionSnapshots);

    if (type) {
        // @ts-ignore - type column added dynamically
        return query.where(eq(sessionSnapshots.type, type)).orderBy(desc(sessionSnapshots.createdAt));
    }

    return query.orderBy(desc(sessionSnapshots.createdAt));
}
