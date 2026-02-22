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
});

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `Tu es un expert en stratégie d'achat retail. Ton rôle est de catégoriser ce produit (A=Permanent, C=Saisonnier, Z=Sortie) via une analyse de VALEUR CONTEXTUELLE.

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

    // Format monthly sales for the prompt
    const monthlySummary = Object.entries(p.sales12m)
        .map(([k, v]) => `${k}: ${Math.round(v)} unités`)
        .join(", ");

    const userMessage = `Produit: "${p.libelle1}" (Code: ${p.codein})
Gamme actuelle: ${p.codeGamme ?? "Non définie"}
Score de performance: ${p.score ?? "N/A"}/100
CA total 12m: ${p.totalCa.toFixed(0)}€ | Taux de marge: ${p.tauxMarge.toFixed(1)}% | Volume: ${Math.round(p.totalQuantite)} unités
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

        return NextResponse.json({ insight: content, codein: p.codein });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
