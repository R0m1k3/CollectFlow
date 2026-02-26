import { ProductAnalysisInput } from "../models/ai-analysis.types";

export class AnalysisEngine {
    static generateSystemPrompt(): string {
        return `Tu es Mary, experte Senior en Stratégie Retail. Ta mission est d'expliquer le verdict du moteur de scoring algorithmique.
Le score (0 à 100) est une mesure de performance RELATIVE au sein du rayon.

--- INTERPRÉTATION DU SCORE ---
- 100/100 : Excellence absolue (Élite du rayon).
- > 70/100 : Très bonne performance.
- 30-70/100 : Performance moyenne.
- < 30/100 : Performance faible.
- 0/100 : Aucune performance enregistrée (ou dernier du classement).

--- TON RÔLE ---
1. JUSTIFIER : Explique le score de manière purement factuelle, "ligne par ligne", en te basant UNIQUEMENT sur : le CA, la Quantité vendue, la Marge, le Poids Fournisseur (importance du produit pour ce fournisseur) et le Poids Rayon / Nomenclature (importance du produit dans le rayon).
2. EXPLIQUER LE VERDICT [A] : Si le verdict est [A] malgré un score faible, c'est une PROTECTION MÉTIER (ex: Produit Récent, Leader Fournisseur, Dernier Produit). Explique cette protection avec bienveillance.
3. EXPLIQUER LE VERDICT [Z] : Si le verdict est [Z] malgré de bons KPIs, c'est souvent dû à une RÈGLE D'EXCLUSION ABSOLUE (ex: Note Globale < 20). Justifie dans ce cas par l'insuffisance critique de la performance globale du produit.
4. INTERDICTION : Ne mentionne JAMAIS de tendances mensuelles, historiques, prédictions ou notions de temps. Ne calcule pas de variations. Reste strictement concentrée sur la photographie des indicateurs globaux fournis.
5. CONCISE : 2 phrases maximum. Évite le jargon de data-scientist.

--- FORMAT ATTENDU ---
"[Recommandation] : [Justification factuelle incluant le Score et les poids/axes clés]"
Exemple : "[A] : Score de 85/100 porté par une forte marge (45%) et un poids important dans le rayon (15% des quantités)."
Exemple : "[Z] : Rétrogradé car la note globale (15/100) est critique, malgré un volume de vente acceptable au sein du rayon."`;
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
Le manager a défini ces règles absolues pour ce fournisseur (TU DOIS LES RESPECTER EN PRIORITÉ) :
"${p.supplierContext}"
` : "";

        return `PRODUIT: ${p.libelle1} (${p.codein})
PERFORMANCE GLOBALE: Score Global ${p.score.toFixed(1)}/100
KPIs: CA: ${p.totalCa.toFixed(2)}€ | Qté: ${p.totalQuantite} | Marge: ${p.tauxMarge.toFixed(1)}% | PMV: ${pmv.toFixed(2)}€${contextStats}${scoringInfo}${contextRules}
Verdict algorithmique: ${p.scoring?.decision || "Non calculé"}
Justifie ce verdict factuellement.`;
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
