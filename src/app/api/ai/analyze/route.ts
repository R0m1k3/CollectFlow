import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSavedDatabaseConfig } from "@/features/settings/actions";

const AnalyzeSchema = z.object({
    codein: z.string(),
    libelle1: z.string(),
    totalCa: z.number(),
    tauxMarge: z.number(),
    totalQuantite: z.number(),
    sales12m: z.record(z.string(), z.number()),
    codeGamme: z.string().nullable(),
});

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SYSTEM_PROMPT = `Tu es un expert en analyse de gammes de produits B2B pour un acheteur retail professionnel.
En analysant les données de ventes fournies, génère une recommandation de gamme concise (A=Cœur, B=Complémentaire, C=Saisonnier, Z=Sortie).
Ta réponse doit être en 1-2 phrases maximum, en français, directe et actionnable.
Format: "[Recommandation]: [Justification courte basée sur les données]"`;

export async function POST(req: NextRequest) {
    console.log("[AI] Analysis request received.");
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "google/gemini-flash-1.5";

    if (!apiKey) {
        console.error("[AI] OPENROUTER_API_KEY is missing (neither in env nor in config file).");
        return NextResponse.json({ error: "OPENROUTER_API_KEY not configured. Please set it in Settings." }, { status: 503 });
    }

    console.log(`[AI] Using model: ${model} with API key starting with ${apiKey.substring(0, 10)}...`);

    const body = await req.json();
    const parsed = AnalyzeSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
    }

    const { codein, libelle1, totalCa, tauxMarge, totalQuantite, sales12m, codeGamme } = parsed.data;

    // Format monthly sales for the prompt
    const monthlySummary = Object.entries(sales12m)
        .map(([k, v]) => `${k}: ${Math.round(v)} unités`)
        .join(", ");

    const userMessage = `Produit: "${libelle1}" (Code: ${codein})
Gamme actuelle: ${codeGamme ?? "Non définie"}
CA total 12m: ${totalCa.toFixed(0)}€ | Taux de marge: ${tauxMarge.toFixed(1)}% | Volume: ${Math.round(totalQuantite)} unités
Historique mensuel: ${monthlySummary}

Quelle gamme recommandes-tu et pourquoi ?`;

    try {
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://collectflow.app",
                "X-Title": "CollectFlow AI Copilot",
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userMessage },
                ],
                max_tokens: 150,
                temperature: 0.3,
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            return NextResponse.json({ error: `OpenRouter error: ${err}` }, { status: response.status });
        }

        const data = await response.json();
        const insight = data.choices?.[0]?.message?.content ?? "Analyse indisponible.";

        return NextResponse.json({ insight, codein });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
