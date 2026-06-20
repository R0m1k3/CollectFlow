import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchNetworkMetrics } from "@/lib/qlik-client";
import { upsertNetworkMetrics } from "@/lib/qlik-network-cache";
import { pgGetArticlesByFournisseur } from "@/lib/pg-ff-client";

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

        const metrics = await fetchNetworkMetrics(codes);
        const count = await upsertNetworkMetrics([...metrics.values()]);
        return NextResponse.json({
            success: true,
            fournisseur,
            requested: codes.length,
            fetched: metrics.size,
            upserted: count,
            fetchedAt: new Date().toISOString(),
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[api/qlik/sync]", msg);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}
