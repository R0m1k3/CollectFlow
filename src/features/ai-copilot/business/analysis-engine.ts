import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es un expert en analyse de gammes de produits B2B pour un acheteur retail professionnel.

En analysant les données de ventes fournies, génère une recommandation de gamme impérative parmi :
- [A] - PERMANENT : Produit de fond de rayon avec une rotation régulière et prévisible. Doit être maintenu toute l'année.
- [C] - SAISONNIER : Produit dont les ventes sont concentrées sur des périodes spécifiques (pics saisonniers).
- [Z] - SORTIE : Produit en fin de cycle de vie, sans rotation significative ou en chute libre, devant être retiré du référencement.

Critères de pondération et Règles Métier :
1. Volume Relatif (Flux de stock) : Si le volume est élevé (très supérieur à la moyenne), c'est un produit "fond de rayon" qui génère du trafic. ON LE GARDE (A ou C) même si son CA individuel est faible.
2. Mix CA/Marge (Rentabilité) : Si le volume est faible mais que le produit génère un CA conséquent et une BONNE MARGE, c'est une pépite. ON LE GARDE EN A.
3. Poids Relatif : Analyse toujours la performance du produit PAR RAPPORT AU RESTE (moyenne fournisseur). Un produit doit être Z uniquement s'il est faible sur TOUS les indicateurs (Volume, CA, Marge).
4. Contexte Magasins (Crucial) : Compare le produit à ses pairs. Si le produit est dans 1 magasin, compare son volume à la moyenne des produits à 1 magasin (avgQtyGroup1). Ne le pénalise pas parce qu'il vend moins qu'un produit présent dans 2 magasins ou plus. Un produit à 1 magasin qui performe mieux que la moyenne de son groupe est un excellent candidat A.
5. Régularité : La stabilité sur 12 mois est la signature du Permanent (A).

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
Contexte : Données basées sur ${p.storeCount} magasin(s).
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
