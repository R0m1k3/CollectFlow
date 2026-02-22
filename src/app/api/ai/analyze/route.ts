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
    score: z.number().nullable().optional(),
    // Champs enrichis (optionnels, envoyés par le batch)
    weightInNomenclature2: z.number().optional(),
    adjustedCaWeight: z.number().optional(),
    nomenclature2Weight: z.number().optional(),
    scorePercentile: z.number().optional(),
    moisActifs: z.number().optional(),
    nomenclature: z.string().optional(),
    // Mode batch : retourne du JSON structuré au lieu de texte libre
    batchMode: z.boolean().optional(),
});

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT_INDIVIDUAL = `Tu es un expert en stratégie d'achat retail. Ton rôle est de catégoriser ce produit (A=Permanent, C=Saisonnier, Z=Sortie) via une analyse de VALEUR CONTEXTUELLE.

L'IMPORTANCE ÉCONOMIQUE PRIME SUR LE SCORE DE PERFORMANCE RELATIVE.

HIÉRARCHIE DES CRITÈRES :
1. APPORT ÉCONOMIQUE : Analyse le CA et la Marge. S'ils sont élevés pour ce type de produit/fournisseur, le produit est stratégique (Gamme A), même si le Score est faible.
2. RÉGULARITÉ : Une rotation constante sur l'année (sales12m) est un signe fort de Gamme A.
3. PERFORMANCE RELATIVE : Le Score (0-100) est un indicateur de santé. Un score faible sur un produit qui génère du volume ne justifie PAS une sortie (Z).

DÉFINITION :
- A (Permanent) : Produit stratégique (CA/Marge significatif) OR rotation régulière.
- C (Saisonnier) : Ventes concentrées sur des pics temporels.
- Z (Sortie) : Cumul de : contribution économique insignifiante + marge faible + score médiocre + ventes sporadiques.

Réponse courte, mentionnant la contribution économique et le score. Ne mentionne aucun seuil en euros.
Format: "[Recommandation]: [Justification basée sur la valeur et le score]"`;

const SYSTEM_PROMPT_BATCH = `Tu es un expert en assortiment retail. Categorise ce produit : A (garder en permanence), C (saisonnier), Z (sortir de la gamme).

L'IMPORTANCE ECONOMIQUE PRIME SUR LE SCORE.

DONNEES CLES :
- weightInNomenclature2 : % du CA du produit dans sa categorie. LE CRITERE PRINCIPAL. >= 5% = pilier de categorie → A.
- adjustedCaWeight : % du CA produit dans le total fournisseur (extrapole reseau).
- scorePercentile : rang du produit parmi le fournisseur (50 = median). Utilise CA POUR COMPARER, pas le score brut.
- moisActifs : mois avec ventes > 0 sur 12 mois. >= 8 = rotation reguliere → A. <= 3 = sporadique.

REGLES :
1. weightInNomenclature2 >= 5% → A (pilier de categorie)
2. moisActifs >= 8 → A (fond de rayon, rotation reguliere)
3. scorePercentile >= 50 ET moisActifs >= 4 → A (performeur regulier)
4. moisActifs 2-4 avec pics concentres → C (saisonnier)
5. Z seulement si TOUT est faible : weightInNomenclature2 bas + moisActifs < 5 + scorePercentile < 30

Reponds UNIQUEMENT en JSON : {"recommandationGamme":"A|C|Z","justificationCourte":"..."}`;

export async function POST(req: NextRequest) {
    const config = await getSavedDatabaseConfig();
    const apiKey = process.env.OPENROUTER_API_KEY || config?.openRouterKey;
    const model = config?.openRouterModel || "google/gemini-flash-1.5";

    if (!apiKey) {
        console.error("[AI] OPENROUTER_API_KEY is missing.");
        return NextResponse.json({ error: "OPENROUTER_API_KEY not configured. Please set it in Settings." }, { status: 503 });
    }

    const body = await req.json();
    const parsed = AnalyzeSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
    }

    const p = parsed.data;
    const isBatch = p.batchMode === true;

    // Format monthly sales for the prompt
    const monthlySummary = Object.entries(p.sales12m)
        .map(([k, v]) => `${k}: ${Math.round(v)} unités`)
        .join(", ");

    let userMessage: string;
    let systemPrompt: string;

    if (isBatch) {
        // Mode batch : prompt simplifié avec métriques enrichies, PAS de codeGamme
        systemPrompt = SYSTEM_PROMPT_BATCH;
        const enrichedLines = [
            `Produit: "${p.libelle1}" (${p.codein})`,
            p.nomenclature ? `Nomenclature: ${p.nomenclature}` : null,
            `CA: ${p.totalCa.toFixed(0)} EUR | Marge: ${p.tauxMarge.toFixed(1)}% | Volume: ${Math.round(p.totalQuantite)} unites`,
            p.weightInNomenclature2 != null ? `Poids dans sa categorie N2: ${p.weightInNomenclature2}%` : null,
            p.adjustedCaWeight != null ? `Poids global fournisseur (ajuste): ${p.adjustedCaWeight}%` : null,
            p.nomenclature2Weight != null ? `Poids de la categorie N2 dans le fournisseur: ${p.nomenclature2Weight}%` : null,
            p.scorePercentile != null ? `Rang percentile: ${p.scorePercentile}/100` : null,
            p.moisActifs != null ? `Mois actifs (ventes > 0): ${p.moisActifs}/12` : null,
            `Historique: ${monthlySummary}`,
        ].filter(Boolean).join("\n");
        userMessage = enrichedLines;
    } else {
        // Mode individuel : prompt original
        systemPrompt = SYSTEM_PROMPT_INDIVIDUAL;
        userMessage = `Produit: "${p.libelle1}" (Code: ${p.codein})
Gamme actuelle: ${p.codeGamme ?? "Non définie"}
Score de performance: ${p.score ?? "N/A"}/100
CA total 12m: ${p.totalCa.toFixed(0)}€ | Taux de marge: ${p.tauxMarge.toFixed(1)}% | Volume: ${Math.round(p.totalQuantite)} unités
Historique mensuel: ${monthlySummary}

Quelle gamme recommandes-tu et pourquoi ?`;
    }

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
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userMessage },
                ],
                ...(isBatch ? { response_format: { type: "json_object" } } : {}),
                max_tokens: 150,
                temperature: 0.1,
            }),
        });

        if (response.status === 429) {
            const retryAfter = response.headers.get("Retry-After") || response.headers.get("x-ratelimit-reset-requests");
            const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60;
            return NextResponse.json({ error: "rate_limited", retryAfter: waitSeconds }, { status: 429 });
        }

        if (!response.ok) {
            const err = await response.text();
            return NextResponse.json({ error: `OpenRouter error: ${err}` }, { status: response.status });
        }

        const data = await response.json();
        const content: string = data.choices?.[0]?.message?.content ?? "";

        if (isBatch) {
            // Parse JSON response for batch mode
            let jsonStr = content;
            const start = content.indexOf("{");
            const end = content.lastIndexOf("}");
            if (start !== -1 && end !== -1) {
                jsonStr = content.slice(start, end + 1);
            }
            const result = JSON.parse(jsonStr);
            return NextResponse.json({
                codein: p.codein,
                recommandationGamme: result.recommandationGamme || "A",
                justificationCourte: result.justificationCourte || "",
                isDuplicate: false,
            });
        } else {
            return NextResponse.json({ insight: content, codein: p.codein });
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
