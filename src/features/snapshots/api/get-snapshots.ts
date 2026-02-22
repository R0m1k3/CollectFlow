"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function getSnapshots() {
    return db.select().from(sessionSnapshots).orderBy(desc(sessionSnapshots.createdAt));
}
