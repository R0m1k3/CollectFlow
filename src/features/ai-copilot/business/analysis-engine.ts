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
2. Segmentation par Rayon (Univers) : Privilégie la comparaison "Intra-Rayon". Un produit doit être performant par rapport aux standards de son propre Rayon (Niveau 2).
3. Score de Performance Global (0-10) : Un score > 7 est un indicateur fort pour "Permanent" (A). Un score < 3 est un indicateur fort pour "Sortie" (Z).
4. Régularité des Ventes (0-12 mois) : Un produit avec une vente régulière (> 8 mois/an) est un candidat idéal pour "Permanent" (A). Une régularité faible (< 3 mois) couplée à un volume total faible indique une "Sortie" (Z).
5. Équilibre : Un produit "A" doit justifier sa place par son flux, sa rentabilité brute OU son score global.

Ta réponse doit être courte, directe et sans complaisance.
Format impératif : "[Recommandation]: [Justification courte]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m)
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Stats Réelles : ${Math.round(p.totalQuantite)}u (${p.totalCa.toFixed(2)}€) sur ${p.storeCount} mag.
Stats Pondérées (Base 2 mag) : ${Math.round(p.weightedTotalQuantite || 0)}u (${(p.weightedTotalCa || 0).toFixed(2)}€)`;

        const benchmarks = `
Benchmarks Fournisseur (Global) :
- Moyenne 1 mag: ${Math.round(p.avgQtyGroup1 || 0)}u | Multi-mag: ${Math.round(p.avgQtyGroup2 || 0)}u
Benchmarks Rayon ("${p.libelleNiveau2}") :
- Moyenne 1 mag: ${Math.round(p.avgQtyRayon1 || 0)}u | Multi-mag: ${Math.round(p.avgQtyRayon2 || 0)}u`;

        return `Produit : "${p.libelle1}" (Ref: ${p.codein})
Rayon : ${p.libelleNiveau2 || "Non classé"}
Gamme actuelle : ${p.codeGamme ?? "Non définie"}
${volumeInfo}${benchmarks}
Indicateurs de Performance :
- Score Global App : ${p.score.toFixed(1)}/10
- Régularité des ventes : ${p.regularityScore}/12 mois
- Marge brute : ${p.tauxMarge.toFixed(1)}%
- Historique mensuel (Pondéré) : ${monthlySummary}

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
