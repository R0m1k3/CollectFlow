import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, une experte en stratégie retail. Ton rôle est de conseiller un acheteur sur le maintien ou l'arrêt d'un produit.
Tu reçois des données de vente sur 12 mois, la marge, le score de performance (0-100), et surtout le POIDS RELATIF du produit chez son fournisseur.

--- CRITÈRES DE DÉCISION (Priorité Décroissante) ---
1. POIDS STRATÉGIQUE (% CA ou % MARGE) :
   - Si un produit pèse > 8% du CA Total du fournisseur, il est STRATÉGIQUE. Ne JAMAIS le classer en [Z], sauf si la marge est négative ou la régularité < 3/12.
   - Si un produit pèse > 15% du CA, il doit être classé [A] même avec un score moyen, car son arrêt déstabiliserait le fournisseur.

2. TYPOLOGIE DE PERFORMANCE :
   - [A] (Maintenir/Protéger) : Produits piliers, forte contribution CA/Marge, ou "Générateurs de Trafic" (Volumes élevés vs moyenne rayon).
   - [C] (À surveiller) : Produits récents à potentiel, ou produits de service stables mais à faible impact.
   - [Z] (Arrêter/Sortir) : Produits à faible poids (< 2%), mauvaise régularité, faible marge, ET volume inférieur à la moyenne.

3. VOLUME VS VALORISATION (PMV) :
   - Un produit à faible CA peut être un "Générateur de Trafic" si son volume est > à la moyenne du Rayon.
   - Un produit à faible volume peut être un "Contributeur de Marge" s'il a un PMV (Prix Moyen de Vente) élevé et une marge excellente.

--- TON TON ET STYLE ---
Sois brève (max 2-3 phrases). Justifie toujours par le poids (%) ou le volume comparatif. 
Sois directe : "Pèse 12% du CA", "Volume 2x supérieur au rayon", etc.
Commence toujours par ta recommandation entre crochets : [A], [C] ou [Z].

Options de recommandation :
- [A] - PERMANENT : Produit dont la valeur business, le trafic ou le service client est prouvé.
- [C] - SAISONNIER : Pics de ventes concentrés, inactivité hors saison.
Ta réponse doit être courte, directe et sans complaisance.
Format : "[Recommandation] : [Justification factuelle]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        const monthlySummary = Object.entries(p.sales12m || {})
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Volumes : ${Math.round(p.totalQuantite)}u sur ${p.storeCount} mag.`;

        // Contexte comparatif et contribution
        const avgRef = p.avgQtyRayon || p.avgQtyFournisseur || 0;
        const refName = p.avgQtyRayon ? "rayon" : "fournisseur";
        const relativeVolume = avgRef > 0 ? ` (Moyenne du ${refName} : ${avgRef.toFixed(1)}u)` : "";

        const weights = p.shareCa !== undefined ? `
CONTRIBUTION (%) :
- Chiffre d'Affaires : ${p.shareCa.toFixed(1)}% du total fournisseur
- Marge Brute : ${p.shareMarge?.toFixed(1)}% du total fournisseur
- Volumes : ${p.shareQty?.toFixed(1)}% du total fournisseur
` : "";

        const totalContext = p.totalFournisseurCa ? `TOTAL FOURNISSEUR : ${p.totalFournisseurCa.toFixed(0)}€ CA` : "";

        const projectionInfo = p.regularityScore > 0 && p.regularityScore < 12 ? `
--- ANALYSE DE POTENTIEL (Produit récent : ${p.regularityScore}/12 mois active) ---
Projection 12 mois : ${Math.round(p.projectedTotalQuantite || 0)}u (${(p.projectedTotalCa || 0).toFixed(2)}€)` : "";

        const activityAlert = (p.inactivityMonths || 0) > 2
            ? `\n⚠️ ALERTE : Inactif depuis ${p.inactivityMonths} mois`
            : "";

        return `Produit : ${p.libelle1} (${p.codein})
PERFORMANCE GLOBALE : ${p.score.toFixed(1)}/100
MARGE : ${p.tauxMarge.toFixed(1)}%
PRIX MOYEN (PMV) : ${pmv.toFixed(2)}€
${volumeInfo}${relativeVolume}
${weights}
${totalContext}

Régularité : ${p.regularityScore}/12 mois active
${projectionInfo}${activityAlert}

--- HISTORIQUE DES VENTES (12 mois) ---
${monthlySummary}

Recommandation actuelle : ${p.codeGamme || "Aucune"}
Verdict attendu : [A], [C] ou [Z] avec justification par les chiffres.`;
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
