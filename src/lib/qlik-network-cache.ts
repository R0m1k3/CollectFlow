/**
 * CollectFlow — Cache des metriques reseau Qlik (table qlik_network_metrics).
 *
 * Lecture par lot (jointure grille) + upsert masse (route de sync).
 */

import "server-only";

import { db } from "@/db";
import { qlikNetworkMetrics } from "@/db/schema";
import { inArray, sql } from "drizzle-orm";
import type { NetworkMetric } from "@/lib/qlik-client";

export interface NetworkMetricCached {
    caReseau: number;
    qteReseau: number;
    nbMagasinsReseau: number;
    caParMagasinReseau: number;
    margePctReseau: number;
    fetchedAt: string | null;
}

/** Lit les metriques reseau pour une liste de codes centraux. */
export async function getNetworkMetricsByCodeCentrale(
    codes: string[],
): Promise<Map<string, NetworkMetricCached>> {
    const out = new Map<string, NetworkMetricCached>();
    const unique = [...new Set(codes.filter(Boolean))];
    if (unique.length === 0) return out;

    const rows = await db
        .select()
        .from(qlikNetworkMetrics)
        .where(inArray(qlikNetworkMetrics.codeCentrale, unique));

    for (const r of rows) {
        out.set(r.codeCentrale, {
            caReseau: Number(r.caReseau ?? 0) || 0,
            qteReseau: Number(r.qteReseau ?? 0) || 0,
            nbMagasinsReseau: Number(r.nbMagasinsReseau ?? 0) || 0,
            caParMagasinReseau: Number(r.caParMagasinReseau ?? 0) || 0,
            margePctReseau: Number(r.margePctReseau ?? 0) || 0,
            fetchedAt: r.fetchedAt ? new Date(r.fetchedAt).toISOString() : null,
        });
    }
    return out;
}

/** Upsert en masse des metriques reseau (depuis Qlik). */
export async function upsertNetworkMetrics(metrics: NetworkMetric[]): Promise<number> {
    if (metrics.length === 0) return 0;
    const now = new Date();
    const values = metrics.map((m) => ({
        codeCentrale: m.codeCentrale,
        caReseau: String(m.caReseau),
        qteReseau: String(m.qteReseau),
        nbMagasinsReseau: m.nbMagasinsReseau,
        caParMagasinReseau: String(m.caParMagasinReseau),
        margePctReseau: String(m.margePctReseau),
        periode: m.periode ?? null,
        fetchedAt: now,
    }));

    // Upsert par paquets pour eviter les requetes trop volumineuses.
    const chunk = 500;
    let count = 0;
    for (let i = 0; i < values.length; i += chunk) {
        const batch = values.slice(i, i + chunk);
        await db
            .insert(qlikNetworkMetrics)
            .values(batch)
            .onConflictDoUpdate({
                target: qlikNetworkMetrics.codeCentrale,
                set: {
                    caReseau: sql`excluded.ca_reseau`,
                    qteReseau: sql`excluded.qte_reseau`,
                    nbMagasinsReseau: sql`excluded.nb_magasins_reseau`,
                    caParMagasinReseau: sql`excluded.ca_par_magasin_reseau`,
                    margePctReseau: sql`excluded.marge_pct_reseau`,
                    periode: sql`excluded.periode`,
                    fetchedAt: sql`excluded.fetched_at`,
                },
            });
        count += batch.length;
    }
    return count;
}
