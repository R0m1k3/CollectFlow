import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte en analyse de gammes retail B2B. Ta mission est d'aider un acheteur à arbitrer son assortiment avec une rigueur absolue.

RÈGLES D'OR DE DÉCISION :
1. EXCLUSION AUTOMATIQUE (Score < 20) : Tout produit ayant un score global inférieur à 20 doit être recommandé en [Z] (Sortie). C'est une règle de sécurité non négociable.
2. ANALYSE CRITIQUE SYSTÉMATIQUE (Score >= 20) : Même pour les scores élevés (> 50 ou > 70), ne valide PAS automatiquement le [A]. Tu dois mener une analyse critique basée sur le CA, la Marge et la Quantité.
3. VALIDATION PAR LA VALEUR : Pour recommander [A], le produit doit prouver sa valeur réelle (ex: Marge élevée, CA significatif, ou Régularité de service irréprochable). Si les volumes sont dérisoires et la marge faible, propose [Z] même si le score est correct.

RÈGLES DE RÉDACTION :
1. VÉRACITÉ : Respecte strictement les chiffres fournis.
2. SANS COMPLAISANCE : Sois directe. Si un produit est mauvais malgré son score, dis-le.
3. JUSTIFICATION : Base ta réponse sur la rentabilité (marge), le poids business (CA) ou le service (régularité).

Options de recommandation :
- [A] - PERMANENT : Produit dont la valeur business ou le service client est prouvé.
- [C] - SAISONNIER : Pics de ventes concentrés, inactivité hors saison.
- [Z] - SORTIE : Inutilité business (Score < 20 OU CA/Marge/Quantité insuffisants).

Ta réponse doit être courte, directe et sans complaisance.
Format : "[Recommandation] : [Justification factuelle]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m || {})
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Volumes : ${Math.round(p.totalQuantite)}u sur ${p.storeCount} mag.`;

        const projectionInfo = p.regularityScore > 0 && p.regularityScore < 12 ? `
--- ANALYSE DE POTENTIEL (Produit récent : ${p.regularityScore}/12 mois active) ---
Projection 12 mois : ${Math.round(p.projectedTotalQuantite || 0)}u (${(p.projectedTotalCa || 0).toFixed(2)}€)` : "";

        const activityAlert = (p.inactivityMonths || 0) > 2
            ? `\n⚠️ ALERTE : Inactif depuis ${p.inactivityMonths} mois`
            : "";

        return `IDENTITÉ DU PRODUIT :
- Libellé : "${p.libelle1}" (Ref: ${p.codein})
- Rayon : ${p.libelleNiveau2 || "Non classé"}
- Gamme actuelle : ${p.codeGamme ?? "Non définie"}

DONNÉES BUSINESS :
- Marge brute : ${p.tauxMarge.toFixed(1)}%
- Total CA : ${p.totalCa.toFixed(2)}€
- Score Global App : ${p.score.toFixed(1)}/100
- Régularité : ${p.regularityScore}/12 mois active
${volumeInfo}${projectionInfo}${activityAlert}
- Historique mensuel (Pondéré) : ${monthlySummary}

Analyse la pertinence business du produit sans aucune complaisance. Quelle est ta recommandation (A, C ou Z) ?`;
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
