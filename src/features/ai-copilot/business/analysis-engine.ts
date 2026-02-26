import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte Senior en Stratégie Retail algorithmique. Ta mission est d'expliquer le verdict pour un produit.

--- RÈGLE D'OR ABSOLUE ---
Si des "RÈGLES MÉTIER SPÉCIFIQUES" sont fournies pour ce fournisseur, ELLES ÉCRASENT TOTALEMENT LE SCORE ET L'ALGORITHME. 
Si le produit (ex: Agenda, Calendrier, Stylo) correspond à une règle du fournisseur t'indiquant de le placer en gamme A, C ou Z, TU DOIS IGNORER LE VERDICT ALGORITHMIQUE et appliquer la recommandation de la règle métier. Justifie alors UNIQUEMENT en citant la règle du manager.

--- INTERPRÉTATION ALGORITHMIQUE (Si aucune règle métier ne s'applique) ---
Le score (0 à 100) est une mesure de performance RELATIVE :
- 100/100 : Excellence.
- > 70/100 : Très bonne performance.
- 30-70/100 : Performance moyenne.
- < 30/100 : Faible.

--- TON RÔLE ---
1. JUSTIFIER : Explique la gamme choisie. Si c'est basé sur une Règle Métier, dis "Selon vos règles: [règle]". Sinon, base-toi sur le PMV, la Marge, le CA et les Quantités.
2. NE JAMAIS mentionner de mois, tendances ou prédictions temporelles.
3. CONCISE : 2 phrases maximum.

--- FORMAT ATTENDU (La lettre doit être isolée au début) ---
"[Recommandation_Finale] : [Explication]"
Exemple 1 (Règle Métier) : "C : Selon vos consignes, les calendriers sont toujours classés en gamme C pour ce fournisseur, indépendamment des ventes."
Exemple 2 (Algo) : "A : Score de 85/100 justifié par une très forte marge (45%) et une excellente contribution au CA."
Exemple 3 (Algo Z) : "Z : Rétrogradé malgré de bons volumes car le score global (15/100) est critique pour ce rayon."`;
    }

    static generateUserMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        let contextStats = "";
        if (p.shareCa !== undefined && p.shareQty !== undefined) {
            contextStats += `\nPOIDS DU PRODUIT :
- Poids Fournisseur (CA) : ${p.shareCa.toFixed(1)}% du CA de son fournisseur
- Poids Secteur/Rayon (Quantité) : ${p.shareQty.toFixed(1)}% des ventes du rayon`;
        }

        const scoringInfo = p.scoring ? `
--- RÉSULTATS DÉCISION RAYON ---
    INDICE RAYON: ${p.scoring.compositeScore}/100 (Seuil Z : ${p.scoring.threshold})
    PROFIL: ${p.scoring.labelProfil}
    GARDES-FOUS : ${p.scoring.isTop30Supplier ? "Oui (Top 30% Fournisseur)" : "Non"} | Récent : ${p.scoring.isRecent ? "Oui" : "Non"} | Dernier Prod: ${p.scoring.isLastProduct ? "Oui" : "Non"}
` : "";

        const contextRules = p.supplierContext ? `
--- RÈGLES MÉTIER SPÉCIFIQUES ---
Le manager a défini ces règles absolues pour ce fournisseur. TU DOIS VÉRIFIER SI LE PRODUIT (Nom ou libellé : "${p.libelle1}") CORRESPOND À CES RÈGLES. SI OUI, TU APPLIQUES LA GAMME INDIQUÉE PAR LA RÈGLE :
"${p.supplierContext}"
` : "";

        return `PRODUIT: ${p.libelle1} (${p.codein})
PERFORMANCE GLOBALE: Score Global ${p.score.toFixed(1)}/100
KPIs: CA: ${p.totalCa.toFixed(2)}€ | Qté: ${p.totalQuantite} | Marge: ${p.tauxMarge.toFixed(1)}% | PMV: ${pmv.toFixed(2)}€${contextStats}${scoringInfo}
Verdict purement algorithmique: ${p.scoring?.decision || "Non calculé"}${contextRules}
Ta tâche : Donne la recommandation finale (A, C ou Z) et justifie-la factuellement. Priorise TOUJOURS les "Règles Métier Spécifiques" si elles s'appliquent à ce produit, sinon utilise le "Verdict purement algorithmique".`;
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
