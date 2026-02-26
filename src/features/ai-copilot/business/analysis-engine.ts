import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte Senior en Stratégie Retail algorithmique. Ta mission est d'expliquer le verdict pour un produit.

--- RÈGLES DE DÉCISION ---
1. RÈGLE MÉTIER SPÉCIFIQUE (Priorité Absolue) : Si le manager a défini une règle et que LE PRODUIT ACTUEL correspond exactement à la condition de cette règle, le score et l'algorithme sont annulés. Tu dois suivre la recommandation de la règle et justifier par "Selon vos consignes...".
2. ALGORITHME (Par défaut) : Si aucune règle métier n'est fournie OU si le produit actuel n'est pas ciblé par la règle, base-toi sur le PMV, la Marge, le CA et les Quantités. Le score (0 à 100) est une mesure relative (100 = Excellence, <30 = Faible).

--- Interdictions ---
Ne mentionne jamais de mois, de tendances ou de prédictions. Sois très concise (2 phrases max).

--- FORMAT DE RÉPONSE OBLIGATOIRE ---
Tu dois UNIQUEMENT répondre avec un objet JSON valide, sans markdown, sans \`\`\`json. 
Structure attendue :
{
  "rule_applies": boolean, // true si le produit est ciblé par la règle métier fournie, sinon false
  "recommendation": "A" | "C" | "Z", // La lettre finale retenue
  "justification": "Texte court expliquant le choix."
}`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        let contextStats = "";
        if (p.shareCa !== undefined && p.shareQty !== undefined) {
            contextStats += `\nPOIDS DU PRODUIT :
- Poids Fournisseur (CA) : ${p.shareCa.toFixed(1)}% du CA de son fournisseur
- Poids Secteur/Rayon (Quantité) : ${p.shareQty.toFixed(1)}% des ventes du rayon`;
        }

        const scoringInfo = p.scoring ? `
--- RÉSULTATS DÉCISION RAYON ---
    INDICE RAYON: ${p.scoring.compositeScore}/100 (Seuil Z : ${p.scoring.threshold})
    PROFIL: ${p.scoring.labelProfil}
    GARDES-FOUS : ${p.scoring.isTop30Supplier ? "Oui (Top 30% Fournisseur)" : "Non"} | Récent : ${p.scoring.isRecent ? "Oui" : "Non"} | Dernier Prod: ${p.scoring.isLastProduct ? "Oui" : "Non"}
` : "";

        const contextRules = p.supplierContext ? `
--- RÈGLES MÉTIER SPÉCIFIQUES ---
Le manager a défini cette consigne pour ce fournisseur : 
"${p.supplierContext}"

Attention : Évalue d'abord si le produit ("${p.libelle1}") est concerné par cette consigne. Si oui, \`rule_applies\` doit être \`true\`. Sinon, \`false\`.
` : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
Famille / Rayon : ${p.libelleNiveau2}
Score Algorithmique : ${p.score.toFixed(1)}/100
KPIs : CA: ${p.totalCa.toFixed(2)}€ | Qté: ${p.totalQuantite} | Marge: ${p.tauxMarge.toFixed(1)}% | PMV: ${pmv.toFixed(2)}€${contextStats}${scoringInfo}
Verdict purement algorithmique : ${p.scoring?.decision || "Non calculé"}${contextRules}

Génère UNIQUEMENT le JSON :`;
    }

    static extractRecommendation(content: string): "A" | "C" | "Z" | null {
        // Recherche une lettre A, C ou Z isolée (entourée de non-lettres ou début/fin)
        const match = content.match(/\b([ACZ])\b/i);
        if (match) {
            return match[1].toUpperCase() as "A" | "C" | "Z";
        }
        return null;
    }

    /**
     * Nettoie le texte de l'IA pour ne garder que la justification pure.
     * Supprime les préfixes comme "[A] :", "Justification :", "Justification courte :", etc.
     */
    static cleanInsight(content: string): string {
        let cleaned = content;

        // Supprime le préfixe de recommandation type "A : ", "[A] - ", "A -" au début
        cleaned = cleaned.replace(/^\[?[ACZ]\]?\s*[:\s-]+\s*/i, "");

        // Supprime les préfixes de justification connus (insensible à la casse, gère variations)
        cleaned = cleaned.replace(/^(justification|explication|pourquoi|justification courte|raison|avis)\s*[:\s-]+\s*/i, "");

        return cleaned.trim();
    }
}
