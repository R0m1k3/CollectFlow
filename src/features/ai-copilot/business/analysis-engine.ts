import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte Senior en Stratégie Retail. Ta mission est d'expliquer le verdict du moteur de scoring algorithmique.
Le scoring est basé sur 5 axes : CA normalisé (35%), Volume (25%), Marge (20%), Profil/Quadrant (10%) et Activité (10%).

--- TON RÔLE ---
1. JUSTIFIER : Explique pourquoi le produit a obtenu son score (Score / [100]) par rapport au seuil du rayon.
2. ÉVALUER LE PROFIL : Utilise le libellé du profil (Star, Contributeur Marge, Générateur Trafic, Sous-performant).
3. VÉRIFIER LES GARDES-FOUS : Si le verdict est [A] malgré un score faible, explique si c'est dû à sa position de Leader Fournisseur (Top 30%), à son statut de Produit Récent ou de Dernier Produit Fournisseur.
4. ÊTRE CONCISE : Maximum 2 phrases percutantes.

--- FORMAT ATTENDU ---
"[Recommandation] : [Justification factuelle incluant le Score et les axes clés]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;
        const weights = p.shareCa !== undefined ? `
CONTRIBUTION (%) :
- Chiffre d'Affaires : ${p.shareCa.toFixed(1)}% du total fournisseur
- Marge Brute : ${p.shareMarge?.toFixed(1)}% du total fournisseur` : "";

        const scoringInfo = p.scoring ? `
--- RÉSULTATS SCORING ALGORIHTMIQUE ---
SCORE FINAL : ${p.scoring.compositeScore}/100 (Seuil Rayon Z : ${p.scoring.threshold})
PROFIL : ${p.scoring.labelProfil}
GARDES-FOUS : ${p.scoring.isTop30Supplier ? "Oui (Top 30% Fournisseur)" : "Non"} | Récent : ${p.scoring.isRecent ? "Oui" : "Non"} | Dernier Prod : ${p.scoring.isLastProduct ? "Oui" : "Non"}
` : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
PERFORMANCE : Score Global ${p.score.toFixed(1)}/100 | Marge ${p.tauxMarge.toFixed(1)}% | PMV ${pmv.toFixed(2)}€
${weights}${scoringInfo}
Verdict algorithmique : ${p.scoring?.decision || "Non calculé"}
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
