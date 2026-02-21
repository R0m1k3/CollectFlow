import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSavedDatabaseConfig } from "@/features/settings/actions";

// Schema for the incoming request
const BatchAnalyzeSchema = z.object({
    rayon: z.string(),
    products: z.array(z.object({
        codein: z.string(),
        gtin: z.string().nullable().optional(),
        nom: z.string().nullable().optional(),
        ventes: z.number().nullable().optional(),
        marge: z.number().nullable().optional(),
    })),
});

export async function POST(req: NextRequest) {
    // Read the API key from DB config (same pattern as /api/ai/analyze)
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "meta-llama/llama-3.3-70b-instruct:free";

    if (!apiKey) {
        console.error("[batch-analyze] API key manquante.");
        return NextResponse.json({ error: "Clé API OpenRouter manquante. Configurez-la dans les Paramètres." }, { status: 500 });
    }

    try {
        const body = await req.json();
        const parsed = BatchAnalyzeSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json({ error: "Format de données invalide." }, { status: 400 });
        }

        const { rayon, products } = parsed.data;

        // Prompt definition
        const systemPrompt = `Tu es un expert en Retail et en gestion d'assortiment. 
Ta mission est d'analyser un lot de produits appartenant au rayon "${rayon}".
Pour chaque produit, tu dois recommander une Gamme (A, B, C ou Z) basée sur ses performances de ventes (volume) et sa marge (%).
Tu dois aussi détecter les doublons évidents (même produit, GTIN similaire, ventes réparties) en mettant isDuplicate: true le cas échéant.

Règles de Gamme :
- A : Produit phare, rotation forte, excellente marge.
- B : Produit cœur de gamme, rotation moyenne.
- C : Dépannage ou niche, faible rotation mais potentiellement bonne marge.
- Z : Produit à déréférencer ou mort (ventes très faibles, marge mauvaise).

TU DOIS REPONDRE UNIQUEMENT EN FORMAT JSON VALIDE. AUCUN TEXTE AVANT OU APRES.
Format attendu:
{
  "results": [
    {
      "codein": "123",
      "recommandationGamme": "A",
      "isDuplicate": false,
      "justificationCourte": "Forte rotation et excellente marge."
    }
  ]
}`;

        const userPrompt = `Analyse cette liste de produits :\n${JSON.stringify(products, null, 2)}`;

        // Retry loop for 429 rate limiting — reads Retry-After header
        let response: Response | null = null;
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.1,
                }),
            });

            if (response.status !== 429) break; // Success or non-retryable error

            const retryAfterHeader = response.headers.get("Retry-After") || response.headers.get("x-ratelimit-reset-requests");
            const waitSeconds = retryAfterHeader ? Math.min(parseInt(retryAfterHeader, 10), 90) : 30 * attempt;
            console.warn(`[batch-analyze] 429 on attempt ${attempt}/${MAX_RETRIES}. Waiting ${waitSeconds}s...`);
            await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        }

        if (!response || !response.ok) {
            const err = response ? await response.text() : "No response";
            console.error("OpenRouter API Error:", err);
            return NextResponse.json({ error: "Erreur lors de l'appel à OpenRouter." }, { status: response?.status ?? 500 });
        }

        const data = await response.json();
        const content: string = data.choices?.[0]?.message?.content ?? "";

        console.log("[batch-analyze] Raw LLM response:", content.slice(0, 500));

        if (!content) {
            return NextResponse.json({ error: "Réponse vide du modèle." }, { status: 500 });
        }

        // Try to extract JSON block from the response (handles markdown code blocks and raw JSON)
        let jsonStr = content;
        const jsonBlock = content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonBlock) {
            jsonStr = jsonBlock[1];
        } else {
            // Look for first { ... } block
            const start = content.indexOf("{");
            const end = content.lastIndexOf("}");
            if (start !== -1 && end !== -1) {
                jsonStr = content.slice(start, end + 1);
            }
        }

        const resultJson = JSON.parse(jsonStr);
        console.log("[batch-analyze] Parsed results count:", resultJson?.results?.length ?? "N/A");

        return NextResponse.json(resultJson);

    } catch (error) {
        console.error("Batch Analyze Error:", error);
        return NextResponse.json({ error: "Erreur interne du serveur." }, { status: 500 });
    }
}
