import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es un expert en analyse de gammes de produits B2B pour un acheteur retail professionnel.

En analysant les données de ventes fournies, génère une recommandation de gamme :
- A (Permanent) : Produit avec rotation régulière, CA stable ou en croissance.
- C (Saisonnier) : Produit avec pics de ventes spécifiques (saisonnalité marquée).
- Z (Sortie) : Produit en fin de vie, rotation insignifiante ou CA en chute libre.

Critères de pondération :
1. Volume et CA : Priorité aux produits générant du flux.
2. Volume Relatif : Compare le volume du produit à la moyenne du fournisseur (fournie). Un produit très au-dessus de la moyenne est un pilier (A).
3. Marge : Un produit à forte marge mais faible rotation peut être maintenu en C.
4. Régularité : La stabilité des ventes sur 12 mois favorise le score A.

Ta réponse doit être en 1-2 phrases maximum, en français, directe et actionnable.
Format impératif : "[Recommandation]: [Justification courte]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m)
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeContext = p.avgTotalQuantite
            ? `- Volume vs Moyenne Fournisseur : ${Math.round(p.totalQuantite)}u (Moyenne: ${Math.round(p.avgTotalQuantite)}u)`
            : `- Volume total : ${Math.round(p.totalQuantite)} unités`;

        return `Produit : "${p.libelle1}" (Ref: ${p.codein})
Gamme actuelle : ${p.codeGamme ?? "Non définie"}
Indicateurs 12m :
- CA : ${p.totalCa.toFixed(2)}€
- Marge : ${p.tauxMarge.toFixed(1)}%
${volumeContext}
- Historique mensuel : ${monthlySummary}

Quelle est ta recommandation (A, C ou Z) et pourquoi ?`;
    }

    static extractRecommendation(content: string): "A" | "C" | "Z" | null {
        // Recherche une lettre A, C ou Z isolée (entourée de non-lettres ou début/fin)
        // On favorise le format [A] ou "A:" mais on accepte A seul.
        const match = content.match(/\b([ACZ])\b/i);
        if (match) {
            return match[1].toUpperCase() as "A" | "C" | "Z";
        }
        return null;
    }
}
