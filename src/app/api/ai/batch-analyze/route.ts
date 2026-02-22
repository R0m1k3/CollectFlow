import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSavedDatabaseConfig } from "@/features/settings/actions";

const BatchAnalyzeSchema = z.object({
    rayon: z.string(),
    supplierTotalCa: z.number().optional(),
    supplierTotalMarge: z.number().optional(),
    supplierStats: z.object({
        totalProducts: z.number(),
        medianScore: z.number(),
        scoreDistribution: z.object({
            above70: z.number(),
            between30and70: z.number(),
            below30: z.number(),
        }),
        maxStoreCount: z.number(),
        nomenclature2Count: z.number(),
    }).optional(),
    products: z.array(z.object({
        codein: z.string(),
        nom: z.string().nullable().optional(),
        ca: z.number().nullable().optional(),
        adjustedCaWeight: z.number().optional().default(0),
        weightInNomenclature2: z.number().optional().default(0),
        nomenclature2Weight: z.number().optional().default(0),
        ventes: z.number().nullable().optional(),
        marge: z.number().nullable().optional(),
        scorePercentile: z.number().optional().default(0),
        moisActifs: z.number().optional().default(0),
        storeCount: z.number().optional().default(1),
        nomenclature: z.string().nullable().optional(),
    })),
});

export async function POST(req: NextRequest) {
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

        const { rayon, products, supplierTotalCa, supplierTotalMarge, supplierStats } = parsed.data;

        const statsContext = supplierStats
            ? `Fournisseur : ${supplierStats.totalProducts} produits, ${supplierStats.nomenclature2Count} categories N2, ${supplierStats.maxStoreCount} magasins.
CA total : ${supplierTotalCa?.toLocaleString('fr-FR') ?? '?'} EUR. Marge totale : ${supplierTotalMarge?.toLocaleString('fr-FR') ?? '?'} EUR.
Score median du fournisseur : ${supplierStats.medianScore}/100.`
            : "";

        const systemPrompt = `Tu es un expert en assortiment retail. Categorise chaque produit : A (garder), C (saisonnier), Z (sortir).

${statsContext}

DONNEES PAR PRODUIT :
- weightInNomenclature2 : % du CA du produit DANS sa categorie N2. C'est le critere le plus important.
- adjustedCaWeight : % du CA du produit dans le total fournisseur (extrapole au reseau).
- nomenclature2Weight : % du CA de toute la categorie N2 dans le fournisseur.
- scorePercentile : rang du produit parmi tous les produits du fournisseur (0-100, 50 = median).
- moisActifs : nombre de mois avec des ventes sur les 12 derniers mois.
- marge : taux de marge (%).

REGLES DE DECISION (applique dans l'ordre) :

REGLE 1 — PILIER DE CATEGORIE → A
Si weightInNomenclature2 >= 5% → le produit est un pilier de sa categorie → A.

REGLE 2 — ROTATION REGULIERE → A
Si moisActifs >= 8 → produit de fond de rayon avec rotation reguliere → A.

REGLE 3 — BON PERFORMEUR → A
Si scorePercentile >= 50 ET moisActifs >= 4 → au-dessus de la moyenne → A.

REGLE 4 — SAISONNIER → C
Si moisActifs entre 2 et 4 ET les ventes sont concentrees sur des mois specifiques → C.

REGLE 5 — SORTIE → Z
Si le produit ne remplit AUCUNE des regles 1-4, c'est un candidat Z.
Un produit ne doit etre Z que s'il cumule : weightInNomenclature2 faible + moisActifs < 5 + scorePercentile < 30.

REGLE DE COHERENCE OBLIGATOIRE :
Compare les produits ENTRE EUX dans ce lot. Si le produit X a un meilleur scorePercentile ET un meilleur weightInNomenclature2 que le produit Y, alors X doit avoir une recommandation >= Y. Ne mets JAMAIS en Z un produit meilleur qu'un autre en A.

REPONDS EN JSON VALIDE uniquement :
{
  "results": [
    {
      "codein": "ID",
      "recommandationGamme": "A|C|Z",
      "isDuplicate": false,
      "justificationCourte": "N2: X%, Perc: Y, Mois: Z -> Regle N"
    }
  ]
}`;

        const userPrompt = `${products.length} produits du rayon "${rayon}" (sur ${supplierStats?.totalProducts ?? products.length} au total).
${JSON.stringify(products, null, 2)}`;

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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

        if (response.status === 429) {
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

        let jsonStr = content;
        const jsonBlock = content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonBlock) {
            jsonStr = jsonBlock[1];
        } else {
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
