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
        score: z.number().nullable().optional(),
        codeGamme: z.string().nullable().optional(),
        sales12m: z.record(z.string(), z.number()).nullable().optional(),
        nomenclature: z.string().nullable().optional(),
    })),
});

export async function POST(req: NextRequest) {
    // Read the API key from DB config (same pattern as /api/ai/analyze)
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "google/gemini-flash-1.5";

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

        // Context-Aware System Prompt: Relative weighting within the batch
        const systemPrompt = `Tu es un expert en stratégie d'achat retail. Ton rôle est de catégoriser les produits d'un fournisseur (A=Permanent, C=Saisonnier, Z=Sortie) en analysant leur POIDS RELATIF dans le lot fourni.

L'IMPORTANCE RELATIVE AU SEIN DU LOT PRIME SUR LE SCORE DE PERFORMANCE.

MÉTHODOLOGIE D'ANALYSE :
1. ANALYSE DU LOT : Identifie les produits qui portent le business du fournisseur (Top contributeurs en CA et Marge au sein de ce groupe).
2. RÈGLE D'OR (PROTECTION DES PILIERS) : Un produit avec une contribution significative (ex: dans les 20% supérieurs du lot en CA ou Marge) est stratégique (Gamme A). Son Score faible indique un besoin d'optimisation, PAS une sortie (Z).
3. HIÉRARCHIE DÉCISIONNELLE :
   a. Poids relatif dans le lot (CA/Marge %) -> Priorité 1
   b. Régularité des ventes (sales12m) -> Priorité 2
   c. Performance relative (Score 0-100) -> Priorité 3 (Simple indicateur de santé).

DÉFINITION DES GAMMES :
- A (Permanent) : Produit "pilier" par son poids relatif OU sa rotation régulière.
- C (Saisonnier) : Pics de ventes saisonniers clairs.
- Z (Sortie) : Cumul de : poids insignifiant dans le lot + marge faible + score médiocre + ventes sporadiques.

IMPORTANT : RÉPONDS UNIQUEMENT EN JSON VALIDE.
La justification doit obligatoirement situer le produit par rapport au reste du lot (ex: "Top 10% du CA du lot"). Ne donne aucun seuil en euros.

Format:
{
  "results": [
    {
      "codein": "ID",
      "recommandationGamme": "A|C|Z",
      "isDuplicate": boolean,
      "justificationCourte": "Justification incluant le poids relatif (ex: 'Top contributeur CA du lot, à protéger')."
    }
  ]
}

Données : codein, nom, ca (€), ventes (unités), marge (%), score (0-100), codeGamme (actuel), sales12m (historique), nomenclature.`;

        const userPrompt = `Analyse cette liste de produits: \n${JSON.stringify(products, null, 2)} `;

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey} `,
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
            console.warn(`[batch - analyze] Rate limited.Retry after ${waitSeconds} s.`);
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
        const jsonBlock = content.match(/```json\s * ([\s\S] *?) \s * ```/);
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
