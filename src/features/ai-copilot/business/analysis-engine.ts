import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte en analyse de gammes retail B2B. Ta mission est d'aider un acheteur à arbitrer son assortiment.

HIÉRARCHIE D'ANALYSE (CRITIQUE) :
1. VALEUR BUSINESS (Priorité Maximale) : Analyse le CA et la Marge brute. Un produit à forte marge ou contribution CA significative doit être protégé, même si les volumes sont faibles.
2. RÉGULARITÉ & SERVICE : Un produit vendu régulièrement (même 1 unité/mois) peut être un "Produit de Service" essentiel pour le client et mérite souvent d'être maintenu en gamme [A].
3. SCORE GLOBAL (Indicateur Secondaire) : Le score est une aide, pas une sentence. Un score < 30 n'implique PAS automatiquement une sortie [Z].

RÈGLES D'OR :
1. VÉRACITÉ ABSOLUE : Ne déforme JAMAIS les chiffres fournis.
2. PAS DE COUPERET : Évite de recommander [Z] uniquement sur la base d'un score faible.
3. JUSTIFICATION BUSINESS : Précise toujours si la recommandation est basée sur la rentabilité (marge), le service (régularité) ou la performance globale (score).

Options de recommandation :
- [A] - PERMANENT : Rotation régulière ou produit stratégique/marge/service.
- [C] - SAISONNIER : Pics de ventes concentrés, inactivité hors saison.
- [Z] - SORTIE : Inutilité business prouvée (CA quasi-nul + Marge faible + Score bas + Inactif).

Ta réponse doit être courte, directe et sans complaisance.
Format : "[Recommandation] : [Justification factuelle]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m || {})
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Stats Réelles : ${Math.round(p.totalQuantite)}u sur ${p.storeCount} mag.
Stats Pondérées (Base 2 mag) : ${Math.round(p.weightedTotalQuantite || 0)}u`;

        const projectionInfo = p.regularityScore > 0 && p.regularityScore < 12 ? `
--- ANALYSE DE POTENTIEL (Produit récent : ${p.regularityScore}/12 mois active) ---
Projection 12 mois (Run Rate) : ${Math.round(p.projectedTotalQuantite || 0)}u (${(p.projectedTotalCa || 0).toFixed(2)}€)` : "";

        const activityAlert = (p.inactivityMonths || 0) > 2
            ? `\n⚠️ ALERTE : Inactif depuis ${p.inactivityMonths} mois (Dernière vente: ${p.lastMonthWithSale || "Inconnue"})`
            : "";

        const benchmarks = `
Benchmarks Rayon ("${p.libelleNiveau2}") :
- Moyenne 1 mag: ${Math.round(p.avgQtyRayon1 || 0)}u | Multi-mag: ${Math.round(p.avgQtyRayon2 || 0)}u`;

        return `IDENTITÉ DU PRODUIT :
- Libellé : "${p.libelle1}" (Ref: ${p.codein})
- Rayon : ${p.libelleNiveau2 || "Non classé"}
- Gamme actuelle : ${p.codeGamme ?? "Non définie"}

INDICATEURS BUSINESS (PRIORITAIRES) :
- Marge brute : ${p.tauxMarge.toFixed(1)}%
- Total CA : ${p.totalCa.toFixed(2)}€
- Régularité des ventes : ${p.regularityScore}/12 mois active

INDICATEURS TECHNIQUES (SECONDAIRES) :
- Score Global App : ${p.score.toFixed(1)}/100
${volumeInfo}${projectionInfo}${activityAlert}${benchmarks}
- Historique mensuel (Pondéré) : ${monthlySummary}

Quelle est ta recommandation (A, C ou Z) et pourquoi ?`;
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
