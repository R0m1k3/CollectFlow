import { NextRequest, NextResponse } from "next/server";
import { getSavedDatabaseConfig } from "@/features/settings/actions";
import { OpenRouterClient } from "@/features/ai-copilot/data/open-router-client";
import { ProductAnalysisInput } from "@/features/ai-copilot/models/ai-analysis.types";

// Limite max acceptable pour la route (Node.js self-hosted).
// Evite que le process tourne indéfiniment en cas de deadlock.
export const maxDuration = 55;

export async function POST(req: NextRequest) {
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "google/gemini-flash-1.5";

    if (!apiKey) {
        console.error("[AI] OPENROUTER_API_KEY is missing.");
        return NextResponse.json({ error: "OPENROUTER_API_KEY not configured. Please set it in Settings." }, { status: 503 });
    }

    try {
        const body: ProductAnalysisInput = await req.json();

        // Le supplierContext est déjà injecté par le client (BulkAiAnalyzer) 
        // via une requête unique avant de lancer le batch.
        // Cela nous évite une requête DB N+1 pour chaque produit analysé.

        const client = new OpenRouterClient({ apiKey, model });
        const result = await client.analyzeProduct(body);

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
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
