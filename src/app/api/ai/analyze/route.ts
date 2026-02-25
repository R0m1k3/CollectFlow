import { NextRequest, NextResponse } from "next/server";
import { getSavedDatabaseConfig } from "@/features/settings/actions";
import { OpenRouterClient } from "@/features/ai-copilot/data/open-router-client";
import { ProductAnalysisInput } from "@/features/ai-copilot/models/ai-analysis.types";
import { db } from "@/db";
import { aiSupplierContext } from "@/db/schema";
import { eq } from "drizzle-orm";

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

        // Inject supplier context if available
        if (body.codeFournisseur) {
            try {
                const contextRecord = await db.select()
                    .from(aiSupplierContext)
                    .where(eq(aiSupplierContext.codeFournisseur, body.codeFournisseur))
                    .limit(1);
                if (contextRecord.length > 0 && contextRecord[0].context) {
                    body.supplierContext = contextRecord[0].context;
                }
            } catch (err) {
                console.error("[AI] Failed to fetch supplier context:", err);
            }
        }

        const client = new OpenRouterClient({ apiKey, model });
        const result = await client.analyzeProduct(body);

        return NextResponse.json(result);
    } catch (err) {
        if (err instanceof Error && err.message === "rate_limited") {
            return NextResponse.json({ error: "rate_limited", retryAfter: 30 }, { status: 429 });
        }
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
