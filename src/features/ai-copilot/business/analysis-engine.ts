import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es un expert en analyse de gammes de produits B2B pour un acheteur retail professionnel.

En analysant les données de ventes fournies, génère une recommandation de gamme impérative parmi :
- [A] - PERMANENT : Produit de fond de rayon avec une rotation régulière et prévisible. Doit être maintenu toute l'année.
- [C] - SAISONNIER : Produit dont les ventes sont concentrées sur des périodes spécifiques (pics saisonniers).
- [Z] - SORTIE : Produit en fin de cycle de vie, sans rotation significative ou en chute libre, devant être retiré du référencement.

Critères de pondération et Règles Métier Strictes :
1. Normalisation Totale (Base 2 magasins) : TOUTES les statistiques fournies (Totaux et Historique Mensuel) sont PONDÉRÉES par 2 si le produit n'est présent que dans 1 magasin. L'objectif est de simuler une performance sur une base réseau de 2 magasins.
2. Seuil "Permanent" (A) : Pour être A, un produit doit avoir un volume PONDÉRÉ significatif (ex: > 30-50 unités/an).
3. Seuil "Sortie" (Z) : Un produit avec moins de 10 unités pondérées par an et un CA faible est un candidat naturel à la sortie (Z).
4. Volume/CA/Marge : Un produit "A" doit justifier sa place en rayon par son flux (volume) OU sa rentabilité brute (CA/Marge). S'il est faible sur les deux, c'est un Z.
5. Poids Relatif : Analyse la performance par rapport aux moyennes fournies.

Ta réponse doit être courte, directe et sans complaisance.
Format impératif : "[Recommandation]: [Justification courte]"`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const monthlySummary = Object.entries(p.sales12m)
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `Stats Réelles : ${Math.round(p.totalQuantite)}u (${p.totalCa.toFixed(2)}€) sur ${p.storeCount} mag.
Stats Pondérées (Base 2 mag) : ${Math.round(p.weightedTotalQuantite || 0)}u (${(p.weightedTotalCa || 0).toFixed(2)}€)`;

        const benchmarks = p.avgQtyGroup1 !== undefined && p.avgQtyGroup2 !== undefined
            ? `\nBenchmarks (Volumes moyens) :
- Moyenne mag unique : ${Math.round(p.avgQtyGroup1)}u
- Moyenne multi-magasins : ${Math.round(p.avgQtyGroup2)}u`
            : "";

        return `Produit : "${p.libelle1}" (Ref: ${p.codein})
Gamme actuelle : ${p.codeGamme ?? "Non définie"}
${volumeInfo}${benchmarks}
Indicateurs Clés :
- Marge : ${p.tauxMarge.toFixed(1)}%
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
