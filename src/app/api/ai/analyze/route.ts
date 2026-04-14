import { NextRequest, NextResponse } from "next/server";
import { getSavedDatabaseConfig } from "@/features/settings/actions";
import { OpenRouterClient } from "@/features/ai-copilot/data/open-router-client";
import { ProductAnalysisInput, SiteMonthlyData } from "@/features/ai-copilot/models/ai-analysis.types";
import { getMensuelByArticles, buildLast12MonthsRange } from "@/lib/api-ff-client";

// Limite max acceptable pour la route (Node.js self-hosted).
// Evite que le process tourne indéfiniment en cas de deadlock.
export const maxDuration = 55;

const SITE_LABELS: Record<string, string> = { "292": "Frouard", "579": "Houdemont" };

export async function POST(req: NextRequest) {
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "google/gemini-2.0-flash-001";

    if (!apiKey) {
        console.error("[AI] OPENROUTER_API_KEY is missing.");
        return NextResponse.json({ error: "OPENROUTER_API_KEY not configured. Please set it in Settings." }, { status: 503 });
    }

    try {
        const body: ProductAnalysisInput = await req.json();

        // Si noid est fourni, enrichir avec les données mensuelles per-site depuis FF Nancy
        let enrichedBody = body;
        if (body.noid) {
            try {
                const { dateDebut, dateFin } = buildLast12MonthsRange();
                const mensuelMap = await getMensuelByArticles(
                    [{ codein: body.codein, noid: body.noid, libelle1: body.libelle1, codefou: body.codeFournisseur ?? "" }],
                    dateDebut, dateFin, 1
                );
                const entries = mensuelMap.get(body.codein) ?? [];
                const siteMonthlyData: SiteMonthlyData[] = entries
                    .filter(e => e.site === "292" || e.site === "579")
                    .map(e => ({
                        site: SITE_LABELS[e.site] ?? e.site,
                        mois: e.mois,
                        ventes_qte: Math.abs(parseFloat(e.ventes?.qte_vendue ?? "0") || 0),
                        ventes_ca: Math.abs(parseFloat(e.ventes?.ca_ht ?? "0") || 0),
                        marge: parseFloat(e.ventes?.marge ?? "0") || 0,
                        stock_fin_mois: parseFloat(e.stock_fin_mois ?? "0") || 0,
                        receptions_qte: Math.abs(parseFloat(e.receptions?.qte_recue ?? "0") || 0),
                    }));
                if (siteMonthlyData.length > 0) {
                    enrichedBody = { ...body, siteMonthlyData };
                    console.log(`[AI] Enriched ${body.codein} with ${siteMonthlyData.length} site-monthly entries`);
                }
            } catch (err) {
                console.warn(`[AI] Failed to fetch mensuel for ${body.codein}:`, err);
                // Dégradation gracieuse — continuer sans données mensuelles
            }
        }

        const FALLBACK_MODEL = "google/gemini-2.0-flash-001";
        let client = new OpenRouterClient({ apiKey, model });
        let result;
        try {
            result = await client.analyzeProduct(enrichedBody);
        } catch (modelErr) {
            // If configured model fails (e.g., deprecated), retry with fallback
            const msg = modelErr instanceof Error ? modelErr.message : "";
            if (model !== FALLBACK_MODEL && (msg.includes("400") || msg.includes("404") || msg.includes("OpenRouter error"))) {
                console.warn(`[AI] Model "${model}" failed (${msg}), retrying with fallback ${FALLBACK_MODEL}`);
                client = new OpenRouterClient({ apiKey, model: FALLBACK_MODEL });
                result = await client.analyzeProduct(enrichedBody);
            } else {
                throw modelErr;
            }
        }

        return NextResponse.json(result);
    } catch (err) {
        if (err instanceof Error && err.message === "rate_limited") {
            return NextResponse.json({ error: "rate_limited", retryAfter: 30 }, { status: 429 });
        }
        // Timeout explicite déclenché par l'AbortController du client
        if (err instanceof Error && err.message === "timeout") {
            console.warn(`[AI] Timeout for product analysis — OpenRouter too slow.`);
            return NextResponse.json({ error: "timeout", retryAfter: 5 }, { status: 504 });
        }

        const msg = err instanceof Error ? err.message : "Unknown error";

        // Propager l'état de surcharge Open Router (502 Gateway, 503 Unavailable, 529 Overloaded)
        if (msg.includes("502") || msg.includes("503") || msg.includes("529") || msg.includes("Bad Gateway") || msg.includes("overloaded")) {
            console.warn(`[AI] External API overload detected: ${msg}`);
            return NextResponse.json({ error: "gateway_timeout", detail: msg }, { status: 502 });
        }

        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
