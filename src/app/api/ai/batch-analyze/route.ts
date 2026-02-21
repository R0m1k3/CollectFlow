import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSavedDatabaseConfig } from "@/features/settings/actions";

// Schema for the incoming request
const BatchAnalyzeSchema = z.object({
    rayon: z.string(),
    supplierTotalCa: z.number().optional(),
    supplierTotalMarge: z.number().optional(),
    products: z.array(z.object({
        codein: z.string(),
        nom: z.string().nullable().optional(),
        ca: z.number().nullable().optional(),
        ventes: z.number().nullable().optional(),
        marge: z.number().nullable().optional(),
        score: z.number().nullable().optional(),
        codeGamme: z.string().nullable().optional(),
        sales12m: z.record(z.string(), z.number()).nullable().optional(),
        storeCount: z.number().optional().default(1),
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

        const { rayon, products, supplierTotalCa, supplierTotalMarge } = parsed.data;

        const supplierMetricsContext = supplierTotalCa && supplierTotalMarge
            ? `CONTEXTE FOURNISSEUR TOTAL :
- CA Total Fournisseur : ${supplierTotalCa.toLocaleString('fr-FR')} €
- Marge Totale Fournisseur : ${supplierTotalMarge.toLocaleString('fr-FR')} €

Toute analyse de poids doit se faire par rapport à ce TOTAL FOURNISSEUR global, et non uniquement par rapport au lot envoyé.`
            : "CONTEXTE : Analyse par rapport au lot fourni.";

        // Context-Aware System Prompt: Strategic Purchase Expert
        const systemPrompt = `Tu es un expert en stratégie d'achat retail et category manager. Ton rôle est de catégoriser les produits d'un fournisseur (A=Permanent, C=Saisonnier, Z=Sortie).

${supplierMetricsContext}

MÉTHODOLOGIE D'ANALYSE (APPROCHE PERFORMANCE-FIRST) :

1. ANALYSE DU POTENTIEL (RÈGLE DU MULTI-MAGASIN) :
   - Note le \`storeCount\` de chaque produit. 
   - La majorité des produits sont présents dans 2 magasins. Si un produit a \`storeCount = 1\`, ses données (CA, Ventes, Marge) sont mécaniquement plus faibles car il ne travaille que sur une partie du réseau.
   - **RÈGLE CRITIQUE** : Pour un produit mono-magasin (\`storeCount = 1\`), multiplie mentalement ses indicateurs par **1.7x** pour évaluer son potentiel réel s'il était déployé partout. Compare-le aux autres produits APRES cette extrapolation.

2. CRITÈRE PRINCIPAL - LA SANTÉ (SCORE) :
   - Le Score (0-100) est ton indicateur de performance combiné (rotation, rentabilité relative, tendance).
   - Score > 70 : Produit performant, Gamme A par défaut.
   - Score < 30 : Produit en difficulté, cible prioritaire pour la Gamme Z (sauf si mono-magasin avec fort potentiel extrapolé).

3. LE POIDS COMME BOUCLIER (PROTECTION DES PILIERS) :
   - Un produit avec un MAUVAIS SCORE (< 40) ne reste en Gamme A QUE s'il est un pilier indispensable :
     - Son poids CA/Marge (extrapolé si mono-magasin) est substantiel par rapport au business du fournisseur.
     - OU il génère un flux de volume massif indispensable.

4. ARBITRAGE POUR LA SORTIE (GAMME Z) :
   - Propose la Gamme Z si le produit cumule :
     - Score faible (< 40).
     - ET Contribution négligeable au business global (même après extrapolation 1.7x si mono-magasin).
     - ET Ventes sporadiques.

DÉFINITION DES GAMMES :
- A (Permanent) : Produits sains (Score élevé) OU Piliers business indispensables (gros volume/CA malgré score moyen).
- C (Saisonnier) : Profil de ventes avec saisonnalité marquée.
- Z (Sortie) : Produits non performants et non stratégiques.

IMPORTANT : RÉPONDS UNIQUEMENT EN JSON VALIDE.
Ta justification doit expliquer POURQUOI le produit est maintenu ou sorti. Mentionne explicitement si le produit est pénalisé par sa présence dans un seul magasin (ex: "Mono-magasin : potentiel extrapolé de X€, pilier stratégique").

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
