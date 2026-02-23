import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte en analyse de gammes retail B2B. Ta mission est d'aider un acheteur à arbitrer son assortiment.

RÈGLES D'OR :
1. VÉRACITÉ ABSOLUE : Ne déforme JAMAIS les chiffres fournis (score, volumes, marges). Si le score est de 53.5, ne dis jamais qu'il est < 30.
2. ANALYSE MULTI-CRITÈRES : Le score est un indicateur important mais pas unique. Analyse la cohérence entre le score, le volume de vente et la régularité.
3. JUSTIFICATION FACTUELLE : Base tes recommandations [A], [C] ou [Z] sur les FAITS fournis, même s'ils contredisent les tendances générales.

Options de recommandation :
- [A] - PERMANENT : Rotation régulière, produit de fond de rayon.
- [C] - SAISONNIER : Pics de ventes concentrés, inactivité hors saison.
- [Z] - SORTIE : Fin de cycle, rotation insuffisante ou en chute libre.

Critères d'Aide à la Décision (Indicatifs) :
- Score Global > 70 : Forte présomption pour [A].
- Score Global < 30 : Forte présomption pour [Z].
- Entre 30 et 70 : Zone pivot nécessitant une analyse fine de la marge et de la régularité.
- Inactivité > 2 mois : Signal d'alerte pour [Z] ou [C].

Ta réponse doit être courte, directe et sans complaisance.
Format : "[Recommandation] : [Justification factuelle]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m || {})
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Stats Réelles : ${Math.round(p.totalQuantite)}u (${p.totalCa.toFixed(2)}€) sur ${p.storeCount} mag.
Stats Pondérées (Base 2 mag) : ${Math.round(p.weightedTotalQuantite || 0)}u (${(p.weightedTotalCa || 0).toFixed(2)}€)`;

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

DONNÉES FACTUELLES (À RESPECTER SCRUPULEUSEMENT) :
- Score Global App : ${p.score.toFixed(1)}/100
- Régularité des ventes : ${p.regularityScore}/12 mois
- Marge brute : ${p.tauxMarge.toFixed(1)}%
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
