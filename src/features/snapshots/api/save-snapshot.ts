"use server";

import { db } from "@/db";
import { sessionSnapshots } from "@/db/schema";
import { z } from "zod";
import { sql, and, eq } from "drizzle-orm";
import { verifierSession } from "@/lib/authz";
import { revalidatePath } from "next/cache";

const SaveSnapshotSchema = z.object({
    codeFournisseur: z.string(),
    nomFournisseur: z.string().optional(),
    magasin: z.string(),
    label: z.string().optional(),
    changes: z.record(z.string(), z.object({
        before: z.string().nullable(),
        after: z.string(),
    })),
    type: z.enum(["snapshot", "export"]).optional(),
    summary: z.object({
        totalRows: z.number(),
        totalCa: z.number(),
        totalMarge: z.number(),
        tauxMargeGlobal: z.number(),
    }).optional(),
});

export async function saveSnapshot(raw: unknown) {
    const acces = await verifierSession();
    if (!acces.ok) return { success: false, error: acces.message };

    const parsed = SaveSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
        console.error("Snapshot validation failed:", parsed.error.format());
        return { success: false, error: "Validation failed: " + parsed.error.issues.map((i: any) => i.message).join(", ") };
    }

    const { codeFournisseur, nomFournisseur, magasin, label, changes, summary, type } = parsed.data;
    const rawUserId = acces.utilisateur.id;
    const userId = rawUserId ? parseInt(rawUserId, 10) : null;

    console.log(`[saveSnapshot] User: ${userId} (raw: ${rawUserId}), Supplier: ${codeFournisseur}, Type: ${type}`);

    const finalUserId = (userId && !isNaN(userId)) ? userId : null;

    try {
        const [created] = await db
            .insert(sessionSnapshots)
            .values({
                userId: finalUserId,
                codeFournisseur,
                nomFournisseur: nomFournisseur ?? null,
                magasin,
                label: label ?? `${type === 'export' ? 'Export' : 'Snapshot'} — ${new Date().toLocaleDateString("fr-FR")}`,
                changes,
                summaryJson: summary ?? null,
                type: type ?? "snapshot",
            })
            .returning({ id: sessionSnapshots.id });
        
        revalidatePath("/snapshots");
        revalidatePath("/exports");
        return { success: true, snapshotId: created?.id };
    } catch (err) {
        console.error("Initial snapshot save failed, attempting auto-repair...", err);

        try {
            // Tentative systématique de création de table (no-op si déjà là)
            await db.execute(sql`
                CREATE TABLE IF NOT EXISTS session_snapshots (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER,
                    code_fournisseur VARCHAR(20) NOT NULL,
                    nom_fournisseur VARCHAR(255),
                    magasin VARCHAR(20) NOT NULL,
                    changes JSONB NOT NULL,
                    summary_json JSONB,
                    label TEXT,
                    type VARCHAR(20) DEFAULT 'snapshot',
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `);

            // Si la table existait déjà mais sans la colonne 'type' ou 'user_id', on les ajoute
            try {
                await db.execute(sql`ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'snapshot'`);
                await db.execute(sql`ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS user_id INTEGER`);
            } catch (e) {
                // Ignore
            }

            // Deuxième tentative d'insertion
            const [retryCreated] = await db
                .insert(sessionSnapshots)
                .values({
                    userId: finalUserId,
                    codeFournisseur,
                    nomFournisseur: nomFournisseur ?? null,
                    magasin,
                    label: label ?? `${type === 'export' ? 'Export' : 'Snapshot'} — ${new Date().toLocaleDateString("fr-FR")}`,
                    changes,
                    summaryJson: summary ?? null,
                    type: type ?? "snapshot",
                })
                .returning({ id: sessionSnapshots.id });

            return { success: true, snapshotId: retryCreated?.id };
        } catch (repairErr) {
            // Le détail technique (les deux erreurs) reste dans les journaux du serveur.
            console.error("Snapshot auto-repair/retry failed:", repairErr);
            return { success: false, error: "erreur technique sur le serveur" };
        }
    }
}
