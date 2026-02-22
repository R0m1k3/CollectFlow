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
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
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
                max_tokens: 150,
                temperature: 0.3,
            }),
        });

        if (response.status === 429) {
            throw new Error("rate_limited");
        }

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenRouter error: ${err}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content ?? "";

        return {
            insight: content,
            codein: p.codein,
            recommandation: AnalysisEngine.extractRecommendation(content)
        };
    }
}
