import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte Senior en Stratégie Retail. Ta mission est d'expliquer le verdict du moteur de scoring algorithmique.
Le score (0 à 100) est une mesure de performance RELATIVE au sein du rayon.

--- INTERPRÉTATION DU SCORE ---
- 100/100 : Excellence absolue (Élite du rayon).
- > 70/100 : Très bonne performance.
- 30-70/100 : Performance moyenne.
- < 30/100 : Performance faible.
- 0/100 : Aucune performance enregistrée (ou dernier du classement).

--- TON RÔLE ---
1. JUSTIFIER : Explique le score par les axes (CA, Volume, Marge). Ne dis JAMAIS que le score est une erreur ou "non calculé" s'il est présent.
2. EXPLIQUER LE VERDICT [A] : Si le verdict est [A] malgré un score faible, c'est une PROTECTION MÉTIER (ex: Produit Récent, Leader Fournisseur, Dernier Produit). Explique cette protection avec bienveillance.
3. PROFIL : Utilise le libellé du profil fourni (Star, Contributeur Marge, etc.).
4. CONCISE : 2 phrases maximum. Pas de blabla technique sur les percentiles, parle de "performance relative".

--- FORMAT ATTENDU ---
"[Recommandation] : [Justification factuelle incluant le Score et les axes clés]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;
        const weights = p.shareCa !== undefined ? `
CONTRIBUTION(%) :
- Chiffre d'Affaires : ${p.shareCa.toFixed(1)}% du total fournisseur
    - Marge Brute: ${p.shareMarge?.toFixed(1)}% du total fournisseur` : "";

        const scoringInfo = p.scoring ? `
--- RÉSULTATS SCORING ALGORIHTMIQUE-- -
    SCORE FINAL: ${p.scoring.compositeScore}/100 (Seuil Rayon Z : ${p.scoring.threshold})
PROFIL: ${p.scoring.labelProfil}
GARDES - FOUS : ${p.scoring.isTop30Supplier ? "Oui (Top 30% Fournisseur)" : "Non"} | Récent : ${p.scoring.isRecent ? "Oui" : "Non"} | Dernier Prod: ${p.scoring.isLastProduct ? "Oui" : "Non"}
` : "";

        return `PRODUIT: ${p.libelle1} (${p.codein})
PERFORMANCE: Score Global ${p.score.toFixed(1)}/100 | Marge ${p.tauxMarge.toFixed(1)}% | PMV ${pmv.toFixed(2)}€
${weights}${scoringInfo}
Verdict algorithmique: ${p.scoring?.decision || "Non calculé"}
Justifie ce verdict auprès de l'utilisateur.`;
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
