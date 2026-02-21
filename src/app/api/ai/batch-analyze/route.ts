import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Schema for the incoming request
const BatchAnalyzeSchema = z.object({
    rayon: z.string(), // Context for the LLM
    products: z.array(z.object({
        codein: z.string(),
        gtin: z.string().nullable().optional(),
        nom: z.string().nullable().optional(),
        ventes: z.number().nullable().optional(),
        marge: z.number().nullable().optional(),
    })),
});

export async function POST(req: NextRequest) {
    if (!OPENROUTER_API_KEY) {
        return NextResponse.json({ error: "Clé API OpenRouter manquante." }, { status: 500 });
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

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "meta-llama/llama-3.3-70b-instruct:free",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                response_format: { type: "json_object" }, // Force JSON
                temperature: 0.1, // Low temp for analytical consistency
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            console.error("OpenRouter API Error:", err);
            return NextResponse.json({ error: "Erreur lors de l'appel à OpenRouter." }, { status: response.status });
        }

        const data = await response.json();
        const content = data.choices[0].message.content;

        // Clean up markdown markers if the model ignored response_format
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/{[\s\S]*}/);
        const jsonStr = jsonMatch ? jsonMatch[0].replace(/```json\n|\n```/g, '') : content;

        const resultJson = JSON.parse(jsonStr);

        return NextResponse.json(resultJson);

    } catch (error) {
        console.error("Batch Analyze Error:", error);
        return NextResponse.json({ error: "Erreur interne du serveur." }, { status: 500 });
    }
}
