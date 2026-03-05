import { AnalysisEngine } from "../business/analysis-engine";
import { ProductAnalysisInput, AnalysisResult } from "../models/ai-analysis.types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterConfig {
    apiKey: string;
    model: string;
}

export class OpenRouterClient {
    constructor(private config: OpenRouterConfig) { }

    async analyzeProduct(p: ProductAnalysisInput): Promise<AnalysisResult> {
        // Timeout de 50 secondes : évite le blocage indéfini si OpenRouter est lent,
        // tout en laissant assez de temps aux modèles complexes pour répondre (maxDuration serveur = 55s).
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 50_000);

        let response: Response;
        try {
            response = await fetch(OPENROUTER_URL, {
                method: "POST",
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://collectflow.app",
                    "X-Title": "CollectFlow AI Copilot",
                },
                body: JSON.stringify({
                    model: this.config.model,
                    messages: [
                        { role: "system", content: AnalysisEngine.generateSystemPrompt() },
                        { role: "user", content: AnalysisEngine.generateUserMessage(p) },
                    ],
                    response_format: { type: "json_object" },
                    max_tokens: 150,
                    temperature: 0.1,
                }),
            });
        } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") {
                throw new Error("timeout"); // Géré proprement plus haut
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }


        if (response.status === 429) {
            throw new Error("rate_limited");
        }

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenRouter error: ${err}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content ?? "";

        let reco: "A" | "B" | "C" | "D" | "Z" | null = null;
        let cleanInsight = "Erreur de génération.";

        try {
            // Some models might wrap JSON in markdown blocks despite instructions
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const jsonText = jsonMatch ? jsonMatch[0] : content;
            const parsed = JSON.parse(jsonText);

            reco = parsed.recommendation as "A" | "B" | "C" | "D" | "Z";
            cleanInsight = parsed.justification || "";

            const ruleApplies = parsed.rule_applies === true;

            // Garde-fou de sécurité : On n'autorise B, C ou D QUE si une règle manager s'applique.
            if (!ruleApplies && (reco === "B" || reco === "C" || reco === "D")) {
                reco = "A";
            }

            // Override recommendation if it doesn't match extracted reco for safety
            if (!reco || !["A", "B", "C", "D", "Z"].includes(reco)) {
                reco = AnalysisEngine.extractRecommendation(cleanInsight) || "A";
                // Ré-appliquer le garde-fou pour la reco extraite du texte.
                if (!ruleApplies && (reco === "B" || reco === "C" || reco === "D")) reco = "A";
            }
        } catch (e) {
            console.error("Failed to parse AI JSON response:", content, e);
            // Fallback to text parsing
            reco = AnalysisEngine.extractRecommendation(content);
            cleanInsight = AnalysisEngine.cleanInsight(content);
        }

        return {
            insight: reco ? `[${reco}] ${cleanInsight}` : cleanInsight,
            codein: p.codein,
            recommandation: reco
        };
    }
}
