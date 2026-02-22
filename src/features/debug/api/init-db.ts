"use server";

import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function initSnapshotTable() {
    try {
        await db.execute(sql`
            CREATE TABLE IF NOT EXISTS session_snapshots (
                id SERIAL PRIMARY KEY,
                code_fournisseur VARCHAR(20) NOT NULL,
                nom_fournisseur VARCHAR(255),
                magasin VARCHAR(20) NOT NULL,
                changes JSONB NOT NULL,
                summary_json JSONB,
                label TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        return { success: true };
    } catch (err) {
        console.error("Init DB error:", err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
