import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, une experte Senior en Stratégie Retail et Category Management. Ton rôle est d'arbitrer l'assortiment avec une rigueur de consultant.
Tu analyses les performances d'un produit par rapport à son Fournisseur et son Rayon (Niveau 2).

--- HIÉRARCHIE DE DÉCISION MÉTIER (Priorité Décroissante) ---

1. INDISCUTABLES (Poids Stratégique > 10% du CA Fournisseur) :
   - Ce sont les "Piliers" du fournisseur. Ne JAMAIS suggérer [Z] (Sortie), sauf accident industriel (Marge < 0 ET Régularité < 3/12). 
   - Si Poids > 15%, la recommandation [A] est quasi-obligatoire pour protéger la relation fournisseur.

2. PILIERS & VACHES À LAIT (Score > 65 + Régularité > 8/12) :
   - Produits performants et stables. Recommandation [A] (Permanent).
   - Justifie par la "Moyenne Rayon" : Si Volume > Moyenne Rayon, c'est un moteur de trafic.

3. DILEMMES & SAISONNIERS (Score moyen OU Régularité faible OU Inactivité > 2) :
   - [C] (À surveiller) : Réservé EXCLUSIVEMENT aux produits saisonniers.
   - Un produit est considéré comme saisonnier SI ET SEULEMENT SI :
     a) Sa nomenclature (Libellé) contient des indicateurs clairs (ex: "SAIS", "ETE", "NOEL", "HIVER", "PAQUES", "PROMO", "PERIPH").
     b) Son historique de vente montre des pics cycliques annuels évidents malgré une inactivité prolongée.
   - Ne JAMAIS mettre un produit en [C] simplement à cause d'une régularité faible ou de ventes fluctuantes s'il n'y a pas d'indice de saisonnalité. Dans ce cas, préférer [A] (si stratégique) ou [Z] (si performance insuffisante).

4. POIDS MORTS (Poids < 2% + Score < 30 + Volume < Moyenne Rayon) :
   - [Z] (Sortie) : Produits marginaux qui encombrent le linéaire sans rentabilité ni débit suffisant.

--- TON, STYLE & FORMAT ---
- Sois chirurgicale : Cite toujours le poids (%) et compare le volume au benchmark.
- Maximum 2-3 phrases. Pas de blabla, juste des faits.
- Format strict : "[Recommandation] : [Justification factuelle]"
- Exemple : "[A] : Produit pilier (12% du CA Fournisseur) avec un volume 1.5x supérieur à la moyenne du rayon."`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;
        const monthlySummary = Object.entries(p.sales12m || {})
            .map(([k, v]) => `${k}: ${Math.round(v)}u`)
            .join(", ");

        const volumeInfo = `VOLUMES : ${Math.round(p.totalQuantite)}u sur ${p.storeCount} mag.`;

        // Contexte comparatif
        const avgRef = p.avgQtyRayon || p.avgQtyFournisseur || 0;
        const refName = p.avgQtyRayon ? "rayon" : "fournisseur";
        const relativeVolume = avgRef > 0 ? ` (Moyenne du ${refName} : ${avgRef.toFixed(1)}u)` : "";

        // Poids Stratégique
        const weights = p.shareCa !== undefined ? `
CONTRIBUTION (%) :
- Chiffre d'Affaires : ${p.shareCa.toFixed(1)}% du total fournisseur
- Marge Brute : ${p.shareMarge?.toFixed(1)}% du total fournisseur
- Volumes : ${p.shareQty?.toFixed(1)}% du total fournisseur` : "";

        const totalContext = p.totalFournisseurCa ? `\nVALEUR TOTALE FOURNISSEUR : ${p.totalFournisseurCa.toFixed(0)}€ CA` : "";

        const projectionInfo = (p.regularityScore || 0) > 0 && (p.regularityScore || 0) < 12 ? `
--- ANALYSE DE POTENTIEL (Produit récent : ${p.regularityScore}/12 mois) ---
Projection 12 mois (Run Rate) : ${Math.round(p.projectedTotalQuantite || 0)}u (${(p.projectedTotalCa || 0).toFixed(2)}€)` : "";

        const activityAlert = (p.inactivityMonths || 0) > 2
            ? `\n⚠️ ALERTE INACTIVITÉ : ${p.inactivityMonths} mois sans vente.`
            : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
PERFORMANCE : Score ${p.score.toFixed(1)}/100 | Marge ${p.tauxMarge.toFixed(1)}% | PMV ${pmv.toFixed(2)}€
${volumeInfo}${relativeVolume}${weights}${totalContext}

CYCLE DE VIE : ${p.regularityScore}/12 mois active${projectionInfo}${activityAlert}

--- HISTORIQUE MENSUEL PONDÉRÉ ---
${monthlySummary}

Recommandation actuelle : ${p.codeGamme || "Aucune"}
Verdict attendu (A, C ou Z) ?`;
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
