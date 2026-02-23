import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte en analyse de gammes retail B2B. Ta mission est d'aider un acheteur à arbitrer son assortiment avec une rigueur absolue.

RÈGLES D'OR DE DÉCISION :
1. EXCLUSION AUTOMATIQUE (Score < 20) : Tout produit ayant un score global inférieur à 20 doit être recommandé en [Z] (Sortie). C'est une règle de sécurité non négociable.
2. ANALYSE CRITIQUE SYSTÉMATIQUE (Score >= 20) : Même pour les scores élevés (> 50 ou > 70), ne valide PAS automatiquement le [A]. Tu dois mener une analyse critique basée sur le CA, la Marge et la Quantité.
3. TYPOLOGIES DE VALEUR :
    - [GÉNÉRATEUR DE TRAFIC] : Si le CA est faible mais que le VOLUME est nettement supérieur à la moyenne du groupe/rayon, le produit est stratégique. Il doit être maintenu [A] car il attire le client, même s'il rapporte peu directement.
    - [CONTRIBUTEUR DE MARGE] : Si le VOLUME est faible mais que le PMV (Prix Moyen de Vente) et la MARGE sont élevés, le produit est un contributeur de valeur.
    - [PRODUIT DE SERVICE] : Produit très régulier (vendu chaque mois) mais à faible enjeux financier. À protéger modérément.
4. VALIDATION PAR LA VALEUR : Pour recommander [A], le produit doit prouver sa valeur réelle. Si les volumes sont dérisoires, le CA faible et la marge faible, propose [Z] même si le score est correct.

RÈGLES DE RÉDACTION :
1. VÉRACITÉ : Respecte strictement les chiffres fournis.
2. SANS COMPLAISANCE : Sois directe. Si un produit est mauvais malgré son score, dis-le.
3. JUSTIFICATION : Base ta réponse sur la rentabilité (marge), le poids business (CA/Volume) ou la typologie (Trafic vs Marge).

Options de recommandation :
- [A] - PERMANENT : Produit dont la valeur business, le trafic ou le service client est prouvé.
- [C] - SAISONNIER : Pics de ventes concentrés, inactivité hors saison.
- [Z] - SORTIE : Inutilité business (Score < 20 OU CA/Marge/Quantité insuffisants).

Ta réponse doit être courte, directe et sans complaisance.
Format : "[Recommandation] : [Justification factuelle]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        const monthlySummary = Object.entries(p.sales12m || {})
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Volumes : ${Math.round(p.totalQuantite)}u sur ${p.storeCount} mag.`;

        // Contexte comparatif des volumes : On préfère la moyenne du rayon si disponible
        const avgRef = p.avgQtyRayon || p.avgQtyFournisseur || 0;
        const refName = p.avgQtyRayon ? "rayon" : "fournisseur";
        const relativeVolume = avgRef > 0 ? ` (Moyenne du ${refName} : ${avgRef.toFixed(1)}u)` : "";

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
- PMV (Prix de Vente Moyen) : ${pmv.toFixed(2)}€
- Score Global App : ${p.score.toFixed(1)}/100
- Régularité : ${p.regularityScore}/12 mois active
${volumeInfo}${relativeVolume}${projectionInfo}${activityAlert}
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
