import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSavedDatabaseConfig } from "@/features/settings/actions";

// Schema for the incoming request
const BatchAnalyzeSchema = z.object({
    rayon: z.string(),
    products: z.array(z.object({
        codein: z.string(),
        nom: z.string().nullable().optional(),
        ca: z.number().nullable().optional(),
        ventes: z.number().nullable().optional(),
        marge: z.number().nullable().optional(),
        gammeInit: z.string().nullable().optional(),
        historique: z.string().nullable().optional(),
        nomenclature: z.string().nullable().optional(),
    })),
});

export async function POST(req: NextRequest) {
    // Read the API key from DB config (same pattern as /api/ai/analyze)
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "meta-llama/llama-3.3-70b-instruct:free";

    if (!apiKey) {
        console.error("[batch-analyze] API key manquante.");
        return NextResponse.json({ error: "Clé API OpenRouter manquante. Configurez-la dans les Paramètres." }, { status: 503 });
    }

    try {
        const body = await req.json();
        const parsed = BatchAnalyzeSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json({ error: "Format de données invalide." }, { status: 400 });
        }

        const { rayon, products } = parsed.data;

        // Optimized System Prompt for professional retail analysis
        const systemPrompt = `Tu es un expert en analyse de gammes B2B (Retail) pour un acheteur professionnel.
Ta mission est d'analyser un lot de produits du rayon "${rayon}".

CRITÈRES DE DÉCISION STRICTS :
- A (Cœur) : Rotation forte (>50 unités/an) ET marge solide. C'est le top 20% des ventes.
- B (Complémentaire) : Rotation correcte ou nouveau produit prometteur.
- C (Saisonnier/Niche) : Faible rotation mais marge élevée (>45%) ou historique saisonnier marqué.
- Z (Sortie - CRITIQUE) : AUCUNE VENTE sur les 12 derniers mois (ou < 3 unités) ET CA quasi nul. Si 'ventes' est proche de 0, il DOIT être en Z sauf si c'est une nouveauté flagrante.

DÉTECTION DE DOUBLONS :
Si plusieurs produits ont des noms quasi identiques et des ventes faibles, marque 'isDuplicate: true' sur le moins performant.

FORMAT DE RÉPONSE (JSON STRICT) :
{
  "results": [
    {
      "codein": "ID",
      "recommandationGamme": "A|B|C|Z",
      "isDuplicate": boolean,
      "justificationCourte": "Directe, basée sur CA/Marge/Ventes (max 15 mots)"
    }
  ]
}

Données fournies : codein, nom, ca (revenue €), ventes (unités), marge (%), gammeInit (actuelle), historique (12 mois), nomenclature (contexte).`;

        const userPrompt = `Analyse cette liste de produits :\n${JSON.stringify(products, null, 2)}`;

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model, // uses the model configured in Settings (same as individual analysis)
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                response_format: { type: "json_object" },
                temperature: 0.1,
            }),
        });

        if (response.status === 429) {
            // Read the retry-after header and pass it back to the client
            const retryAfter = response.headers.get("Retry-After") || response.headers.get("x-ratelimit-reset-requests");
            const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
            console.warn(`[batch-analyze] Rate limited. Retry after ${waitSeconds}s.`);
            return NextResponse.json({ error: "rate_limited", retryAfter: waitSeconds }, { status: 429 });
        }

        if (!response.ok) {
            const err = await response.text();
            console.error("OpenRouter API Error:", response.status, err);
            return NextResponse.json({ error: "Erreur lors de l'appel à OpenRouter.", status: response.status }, { status: response.status });
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
