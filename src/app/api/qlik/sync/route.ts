import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchNetworkMetricsPlaywright } from "@/lib/qlik-playwright";
import { upsertNetworkMetrics } from "@/lib/qlik-network-cache";
import { pgGetArticlesByFournisseur } from "@/lib/pg-ff-client";
import { buildGridNetworkQlikDateFilter } from "@/lib/qlik-date-range";

// Synchro potentiellement longue (extraction hypercube paginee).
export const maxDuration = 300;

/**
 * POST /api/qlik/sync?fournisseur=XXX
 * Tire de Qlik les metriques reseau des articles du fournisseur (par code centrale)
 * et met a jour le cache local. Admin uniquement.
 */
export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session || (session.user as { role?: string } | undefined)?.role !== "admin") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const fournisseur = req.nextUrl.searchParams.get("fournisseur");
    if (!fournisseur) {
        return NextResponse.json({ error: "Param 'fournisseur' requis" }, { status: 400 });
    }

    try {
        // Codes centraux des articles de ce fournisseur
        const articles = await pgGetArticlesByFournisseur(fournisseur);
        const codes = [
            ...new Set(
                articles
                    .map((a) => (a.codeCentrale ? String(a.codeCentrale).trim() : ""))
                    .filter(Boolean),
            ),
        ];
        console.log(`[api/qlik/sync] fournisseur=${fournisseur} — ${articles.length} articles, ${codes.length} codes centraux uniques. Échantillon: ${JSON.stringify(codes.slice(0, 5))}`);
        if (codes.length === 0) {
            return NextResponse.json({
                success: true,
                fournisseur,
                fetched: 0,
                upserted: 0,
                message: "Aucun article avec code centrale pour ce fournisseur",
                fetchedAt: new Date().toISOString(),
            });
        }

        const dateFilter = buildGridNetworkQlikDateFilter();
        console.log(`[api/qlik/sync] → lancement extraction Qlik pour ${codes.length} codes — période ${dateFilter.label} (${dateFilter.dateDebut} → ${dateFilter.dateFin})…`);
        const metrics = await fetchNetworkMetricsPlaywright(codes, undefined, dateFilter);
        console.log(`[api/qlik/sync] ← Qlik a renvoyé ${metrics.size} produits réseau`);
        const count = await upsertNetworkMetrics([...metrics.values()]);
        console.log(`[api/qlik/sync] ${count} lignes upsert dans le cache`);
        return NextResponse.json({
            success: true,
            fournisseur,
            requested: codes.length,
            fetched: metrics.size,
            upserted: count,
            periode: dateFilter.label,
            dateDebut: dateFilter.dateDebut,
            dateFin: dateFilter.dateFin,
            fetchedAt: new Date().toISOString(),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[api/qlik/sync]", msg);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}
