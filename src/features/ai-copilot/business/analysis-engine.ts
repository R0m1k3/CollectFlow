import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es un expert en analyse de gammes de produits B2B pour un acheteur retail professionnel.

En analysant les données de ventes fournies, génère une recommandation de gamme impérative parmi :
- [A] - PERMANENT : Produit de fond de rayon avec une rotation régulière et prévisible. Doit être maintenu toute l'année.
- [C] - SAISONNIER : Produit dont les ventes sont concentrées sur des périodes spécifiques (pics saisonniers).
- [Z] - SORTIE : Produit en fin de cycle de vie, sans rotation significative ou en chute libre, devant être retiré du référencement.

Critères de pondération et Règles Métier Strictes :
1. Normalisation Totale (Base 2 magasins) : TOUTES les statistiques fournies sont PONDÉRÉES par 2 si le produit n'est au catalogue que de 1 magasin.
2. Potentiel Annuel (Run Rate) : Si un produit est récent (Régularité < 12 mois), base ton jugement sur sa "Projection 12m" plutôt que sur son volume brut cumulé.
3. Segmentation par Rayon (Univers) : Privilégie la comparaison "Intra-Rayon". Un produit doit être performant par rapport aux standards de son propre Rayon (Niveau 2).
4. Score de Performance Global (0-100) : Un score > 70 est un indicateur fort pour "Permanent" (A). Un score < 30 est un indicateur fort pour "Sortie" (Z).
5. Équilibre : Un produit "A" doit justifier sa place par son flux, sa rentabilité brute OU son score global.

Ta réponse doit être courte, directe et sans complaisance.
Format impératif : "[Recommandation] : [Texte brut de l'explication sans aucun préfixe du type 'Justification:' ou 'Pourquoi:']"
Exemple : "A : Volume de vente et score élevés justifiant le maintien en rayon."`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m)
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Stats Réelles : ${Math.round(p.totalQuantite)}u (${p.totalCa.toFixed(2)}€) sur ${p.storeCount} mag.
Stats Pondérées (Base 2 mag) : ${Math.round(p.weightedTotalQuantite || 0)}u (${(p.weightedTotalCa || 0).toFixed(2)}€)`;

        const projectionInfo = p.regularityScore < 12 ? `
--- ANALYSE DE POTENTIEL (Produit récent : ${p.regularityScore}/12 mois active) ---
Projection 12 mois (Run Rate) : ${Math.round(p.projectedTotalQuantite || 0)}u (${(p.projectedTotalCa || 0).toFixed(2)}€)` : "";

        const benchmarks = `
Benchmarks Fournisseur (Global) :
- Moyenne 1 mag: ${Math.round(p.avgQtyGroup1 || 0)}u | Multi-mag: ${Math.round(p.avgQtyGroup2 || 0)}u
Benchmarks Rayon ("${p.libelleNiveau2}") :
- Moyenne 1 mag: ${Math.round(p.avgQtyRayon1 || 0)}u | Multi-mag: ${Math.round(p.avgQtyRayon2 || 0)}u`;

        return `Produit : "${p.libelle1}" (Ref: ${p.codein})
Rayon : ${p.libelleNiveau2 || "Non classé"}
Gamme actuelle : ${p.codeGamme ?? "Non définie"}
${volumeInfo}${projectionInfo}${benchmarks}
Indicateurs de Performance :
- Score Global App : ${p.score.toFixed(1)}/100
- Régularité des ventes : ${p.regularityScore}/12 mois
- Marge brute : ${p.tauxMarge.toFixed(1)}%
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
