import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSavedDatabaseConfig } from "@/features/settings/actions";

// Schema for the incoming request
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
        caWeight: z.number().optional().default(0),
        adjustedCaWeight: z.number().optional().default(0),
        ventes: z.number().nullable().optional(),
        marge: z.number().nullable().optional(),
        score: z.number().nullable().optional(),
        scorePercentile: z.number().optional().default(0),
        codeGamme: z.string().nullable().optional(),
        sales12m: z.record(z.string(), z.number()).nullable().optional(),
        storeCount: z.number().optional().default(1),
        nomenclature: z.string().nullable().optional(),
        nomenclature2Weight: z.number().optional().default(0),
        weightInNomenclature2: z.number().optional().default(0),
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

        const { rayon, products, supplierTotalCa, supplierTotalMarge, supplierStats } = parsed.data;

        // Build rich supplier context with distribution awareness
        const supplierMetricsContext = (() => {
            const parts: string[] = [];

            if (supplierTotalCa && supplierTotalMarge) {
                parts.push(`CONTEXTE FOURNISSEUR GLOBAL :
- CA Total Fournisseur : ${supplierTotalCa.toLocaleString('fr-FR')} EUR
- Marge Totale Fournisseur : ${supplierTotalMarge.toLocaleString('fr-FR')} EUR`);
            }

            if (supplierStats) {
                parts.push(`DISTRIBUTION DES SCORES (sur ${supplierStats.totalProducts} produits du fournisseur) :
- Score median : ${supplierStats.medianScore}/100
- Produits score > 70 : ${supplierStats.scoreDistribution.above70} (${Math.round(supplierStats.scoreDistribution.above70 / supplierStats.totalProducts * 100)}%)
- Produits score 30-70 : ${supplierStats.scoreDistribution.between30and70} (${Math.round(supplierStats.scoreDistribution.between30and70 / supplierStats.totalProducts * 100)}%)
- Produits score < 30 : ${supplierStats.scoreDistribution.below30} (${Math.round(supplierStats.scoreDistribution.below30 / supplierStats.totalProducts * 100)}%)
- Nomenclatures N2 distinctes : ${supplierStats.nomenclature2Count}
- Magasins reseau : ${supplierStats.maxStoreCount}

ATTENTION CRITIQUE : Le Score est RELATIF au meilleur produit du fournisseur (le top performer a ~100). Un score median de ${supplierStats.medianScore} signifie que la MOITIE des produits ont un score inferieur a cette valeur. Utilise le \`scorePercentile\` (rang centile) pour comparer les produits entre eux, PAS le score brut.`);
            }

            return parts.join('\n\n');
        })();

        const systemPrompt = `Tu es un expert en strategie d'achat retail et category manager. Ton role est de categoriser les produits d'un fournisseur (A=Permanent, C=Saisonnier, Z=Sortie).

${supplierMetricsContext}

REGLE FONDAMENTALE : L'IMPORTANCE ECONOMIQUE PRIME SUR LE SCORE DE PERFORMANCE RELATIVE.

COMPRENDRE LES DONNEES :
- \`score\` (0-100) : Performance RELATIVE au meilleur produit du fournisseur. Le top produit a ~100. Ce n'est PAS un score absolu de qualite. Un score de 25 peut etre parfaitement normal si le median est a 20.
- \`scorePercentile\` (0-100) : Rang centile du produit parmi TOUS les produits du fournisseur. 50 = median, 80 = top 20%. C'EST L'INDICATEUR A UTILISER pour comparer les produits.
- \`caWeight\` : Poids brut du CA du produit par rapport au total fournisseur (%).
- \`adjustedCaWeight\` : Poids CA extrapole au reseau complet (si un produit n'est present que dans 1 magasin sur 2, son poids est double). UTILISE CETTE VALEUR pour toute decision de poids global.
- \`weightInNomenclature2\` : Poids du produit dans sa propre nomenclature de niveau 2 (%). C'EST LE CRITERE LE PLUS IMPORTANT. Un produit qui pese 8% de sa nomenclature N2 est un pilier de cette categorie.
- \`nomenclature2Weight\` : Poids de la nomenclature N2 entiere dans le CA fournisseur (%). Donne le contexte strategique de la categorie.
- \`sales12m\` : Historique mensuel des ventes (cle YYYYMM). Regarde la REGULARITE, pas seulement le volume.

METHODOLOGIE D'ANALYSE (HIERARCHIE STRICTE) :

1. CONTRIBUTION ECONOMIQUE PAR CATEGORIE (CRITERE PRINCIPAL) :
   - Regarde d'abord \`weightInNomenclature2\` : c'est le poids du produit dans sa categorie N2. Un produit qui pese > 5% de sa nomenclature N2 est un contributeur important de cette categorie → forte protection.
   - Puis regarde \`adjustedCaWeight\` : le poids global. Un produit dans le top 20% des contributeurs du fournisseur → Gamme A quasi certaine.
   - \`nomenclature2Weight\` donne le contexte : si la nomenclature N2 pese > 15% du fournisseur, c'est une categorie strategique et ses contributeurs meritent une protection renforcee.

2. REGULARITE DES VENTES (CRITERE SECONDAIRE) :
   - Compte les mois avec ventes > 0 dans sales12m.
   - 10-12 mois actifs = rotation reguliere = signal fort de Gamme A (produit de fond de rayon indispensable, effet de halo sur la categorie).
   - 4-9 mois actifs = rotation moyenne, a croiser avec la contribution.
   - 1-3 mois actifs = rotation faible, potentiel produit saisonnier (C) ou candidat sortie (Z).
   - Un produit avec ventes regulieres sur 10+ mois est un produit de complement indispensable au rayon, meme si son poids individuel est faible.

3. PERFORMANCE RELATIVE (CRITERE TERTIAIRE) :
   - Utilise \`scorePercentile\` pour situer le produit. PAS le score brut.
   - scorePercentile > 60 : Produit au-dessus de la moyenne → favorable a Gamme A.
   - scorePercentile 30-60 : Produit moyen → decider selon contribution et regularite.
   - scorePercentile < 20 : Produit dans le bas du classement → candidat Z, SAUF si contribution significative dans sa nomenclature ou rotation reguliere.

4. REGLE D'OR DE COHERENCE :
   - Un produit avec un meilleur scorePercentile ET un meilleur adjustedCaWeight qu'un autre DOIT avoir une recommandation egale ou superieure.
   - Ne JAMAIS mettre en Z un produit qui est meilleur qu'un autre reste en A.

5. PROTECTION DES PRODUITS DE COMPLEMENT (EFFET HALO) :
   - Un produit avec une rotation reguliere (8+ mois actifs) et un weightInNomenclature2 > 2% est un produit de complement indispensable au rayon. Il doit rester en A.
   - Avant de proposer Z, verifie que le produit n'est pas un complement naturel d'un produit A majeur du meme rayon/nomenclature.

DEFINITION DES GAMMES :
- A (Permanent) : Produits contribuant significativement a leur categorie N2 (weightInNomenclature2 eleve), OU rotation reguliere (fond de rayon), OU forte performance relative.
- C (Saisonnier) : Profil de ventes avec saisonnalite marquee (pics sur 2-4 mois, quasi-absence le reste).
- Z (Sortie) : UNIQUEMENT si le produit cumule TOUS ces criteres negatifs : weightInNomenclature2 tres faible (marginal dans sa propre categorie) + adjustedCaWeight negligeable + rotation irreguliere (< 5 mois actifs) + scorePercentile dans le dernier quart (< 25).

IMPORTANT : REPONDS UNIQUEMENT EN JSON VALIDE.
Ta justification doit etre factuelle. Mentionne le scorePercentile, le weightInNomenclature2, et le nombre de mois actifs.

Format:
{
  "results": [
    {
      "codein": "ID",
      "recommandationGamme": "A|C|Z",
      "isDuplicate": boolean,
      "justificationCourte": "Poids N2: X%, Poids global: Y%, Percentile: Z, Mois actifs: N -> [Raison]"
    }
  ]
}

Donnees fournies par produit : codein, nom, ca (EUR), caWeight (% global), adjustedCaWeight (% extrapole), weightInNomenclature2 (% dans sa N2), nomenclature2Weight (% de la N2 dans le fournisseur), ventes (unites), marge (%), score (0-100, RELATIF), scorePercentile (0-100, rang centile), codeGamme (actuel), sales12m (historique), storeCount, nomenclature.`;

        const userPrompt = `Ce lot contient ${products.length} produits du rayon "${rayon}" (sur ${supplierStats?.totalProducts ?? products.length} produits au total pour ce fournisseur).

Analyse ces produits :
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

        // Try to extract JSON block from the response (handles markdown code blocks and raw JSON)
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
