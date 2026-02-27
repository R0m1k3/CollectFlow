/**
 * CollectFlow — Analysis Engine (v3 — Prompt Contextuel Multi-Dimensionnel)
 *
 * Mary ne reçoit plus le verdict algorithmique pré-mâché. Elle reçoit une
 * fiche de contexte normalisée (ProductContextProfile) qui lui permet de
 * raisonner de façon autonome et cohérente sur la vraie valeur d'un produit.
 */

import type { ProductAnalysisInput } from "../models/ai-analysis.types";
import type { ProductContextProfile } from "./context-profiler";

export class AnalysisEngine {
    // -----------------------------------------------------------------------
    // SYSTEM PROMPT
    // -----------------------------------------------------------------------

    static generateSystemPrompt(): string {
        return `Tu es Mary, Senior Retail Strategist. Tu analyses des produits pour recommander A (garder), C (saisonnier), ou Z (sortir).

--- PHILOSOPHIE ---
Un produit avec un score faible peut être VITAL s'il génère du trafic ou des marges.
Un produit "moyen" peut être un pilier discret de son rayon.
Ne jamais classer Z sans vérifier sa contribution réelle au chiffre d'affaires et aux volumes.

--- ORDRE DE PRIORITÉ ---
1. RÈGLE ABSOLUE : Score critique (< 20 sur 100) + aucun signal positif → TOUJOURS Z. Pas de discussion.
2. GARDE-FOU : Si isProtected = true (Nouveauté / Dernier Produit / Top30) → TOUJOURS A. Priorité absolue.
3. RÈGLE MANAGER : Si le manager a défini une consigne ET que le produit est concerné → Appliquer la consigne (rule_applies = true).
4. ANALYSE CONTEXTUELLE : Utiliser la fiche de positionnement (percentiles, poids, signaux) pour raisonner.

--- GUIDE D'ANALYSE CONTEXTUELLE ---
• Quadrant STAR ⭐ : Volume ET Marge > médiane → A sauf cas exceptionnel
• Quadrant TRAFIC 🚶 : Fort volume, marge faible → Rôle de locomotive → A, justifier le rôle de trafic
• Quadrant MARGE 💎 : Volume faible, forte marge → Capital rentabilité → A, justifier la contribution marge
• Quadrant WATCH ⚠️ : Volume ET Marge < médiane → Analyser la santé (inactivité, poids CA, poids QTÉ)
  - Si poids CA ou poids QTÉ rayon > 5% → A ou C selon l'inactivité
  - Si poids faibles ET inactivité ≥ 2 mois → Z

--- COHÉRENCE INTER-PRODUITS (OBLIGATOIRE) ---
Ne mets JAMAIS Z un produit dont le percentile CA et le percentile QTÉ sont tous les deux supérieurs à un autre produit déjà recommandé en A.

--- FORMAT DE RÉPONSE OBLIGATOIRE ---
Réponds UNIQUEMENT avec un JSON valide, sans markdown, sans \`\`\`json.
{
  "rule_applies": boolean,
  "recommendation": "A" | "C" | "Z",
  "justification": "2 phrases max. Cite les données clés : percentile, poids, quadrant, signal."
}`;
    }

    // -----------------------------------------------------------------------
    // USER MESSAGE — avec la fiche contextuelle
    // -----------------------------------------------------------------------

    static generateUserMessage(p: ProductAnalysisInput): string {
        // Utilise la fiche ContextProfile si disponible, sinon fallback sur le mode legacy
        if (p.contextProfile) {
            return AnalysisEngine.buildContextualMessage(p, p.contextProfile);
        }
        return AnalysisEngine.buildLegacyMessage(p);
    }

    // -----------------------------------------------------------------------
    // Message contextuel enrichi (nouveau mode MPC)
    // -----------------------------------------------------------------------

    private static buildContextualMessage(
        p: ProductAnalysisInput,
        ctx: ProductContextProfile
    ): string {
        const lines: string[] = [];

        // --- En-tête produit ---
        lines.push(`PRODUIT : ${ctx.libelle1} (${ctx.codein})`);
        lines.push(`CATÉGORIE : ${ctx.libelleNiveau2} (${ctx.rayonSize} produits dans ce rayon sur ${ctx.lotSize} au total)`);
        lines.push("");

        // --- Quadrant ---
        lines.push(`--- PROFIL QUADRANT ---`);
        lines.push(`${ctx.quadrantEmoji} ${ctx.quadrantLabel}`);
        lines.push(`Santé : ${ctx.regularityScore}/12 mois actifs | ${ctx.inactivityMonths} mois sans vente | Marge : ${ctx.tauxMarge.toFixed(1)}%`);
        lines.push("");

        // --- Positionnement dans le lot ---
        lines.push(`--- POSITION DANS LE LOT FOURNISSEUR (${ctx.lotSize} produits) ---`);
        lines.push(`• CA       : ${ctx.percentileCa}e percentile | Poids fournisseur : ${ctx.weightCaFournisseur}% | Poids rayon : ${ctx.weightCaRayon}%`);
        lines.push(`• Quantité : ${ctx.percentileQty}e percentile | Poids fournisseur : ${ctx.weightQtyFournisseur}% | Poids rayon : ${ctx.weightQtyRayon}%`);
        lines.push(`• Marge    : ${ctx.percentileMarge}e percentile`);
        lines.push(`• Score composite : ${ctx.percentileComposite}/100`);
        lines.push("");

        // --- Signaux ---
        lines.push(`--- SIGNAUX ---`);
        lines.push(`${ctx.isTop20Ca ? "[✓]" : "[ ]"} Top 20% CA fournisseur`);
        lines.push(`${ctx.isTop20Qty ? "[✓]" : "[ ]"} Top 20% Quantités fournisseur`);
        lines.push(`${ctx.isHighVolumeWithLowMargin ? "[✓]" : "[ ]"} Signal Trafic : fort volume ET marge < P40 du lot → rôle de locomotive`);
        lines.push(`${ctx.isMargePure ? "[✓]" : "[ ]"} Signal Marge : marge > P70 du lot → capital rentabilité`);
        lines.push(`${ctx.isAboveMedianComposite ? "[✓]" : "[ ]"} Au-dessus de la médiane composite`);
        lines.push(`${ctx.scoreCritique ? "[✗ CRITIQUE]" : "[ ]"} Score brut critique (< 20) — candidat Z direct si aucun signal positif`);
        lines.push("");

        // --- Protection ---
        if (ctx.isProtected) {
            lines.push(`🛡️ GARDE-FOU ACTIF : ${ctx.protectionReason} → Recommandation A obligatoire`);
            lines.push("");
        }

        // --- Règles manager ---
        if (p.supplierContext) {
            lines.push(`--- RÈGLE MANAGER ---`);
            lines.push(`"${p.supplierContext}"`);
            lines.push(`→ Évalue si ce produit ("${ctx.libelle1}") est concerné par cette consigne.`);
            lines.push("");
        }

        lines.push(`Génère UNIQUEMENT le JSON :`);

        return lines.join("\n");
    }

    // -----------------------------------------------------------------------
    // Fallback legacy (si contextProfile absent — compatibilité ascendante)
    // -----------------------------------------------------------------------

    private static buildLegacyMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        let contextStats = "";
        if (p.shareCa !== undefined && p.shareQty !== undefined) {
            contextStats += `\nPOIDS DU PRODUIT :
- Poids Fournisseur (CA) : ${p.shareCa.toFixed(1)}% du CA de son fournisseur
- Poids Secteur/Rayon (Quantité) : ${p.shareQty.toFixed(1)}% des ventes du rayon`;
        }

        const scoringInfo = p.scoring
            ? `\n--- RÉSULTATS DÉCISION RAYON ---
    INDICE RAYON: ${p.scoring.compositeScore}/100 (Seuil Z : ${p.scoring.threshold})
    PROFIL: ${p.scoring.labelProfil}
    GARDES-FOUS : ${p.scoring.isTop30Supplier ? "Oui (Top 30% Fournisseur)" : "Non"} | Récent : ${p.scoring.isRecent ? "Oui" : "Non"} | Dernier Prod: ${p.scoring.isLastProduct ? "Oui" : "Non"}
`
            : "";

        const contextRules = p.supplierContext
            ? `\n--- RÈGLES MÉTIER SPÉCIFIQUES ---
Le manager a défini cette consigne pour ce fournisseur :
"${p.supplierContext}"

Attention : Évalue d'abord si le produit ("${p.libelle1}") est concerné par cette consigne. Si oui, \`rule_applies\` doit être \`true\`. Sinon, \`false\`.
`
            : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
Famille / Rayon : ${p.libelleNiveau2}
Score Algorithmique : ${p.score.toFixed(1)}/100
KPIs : CA: ${p.totalCa.toFixed(2)}€ | Qté: ${p.totalQuantite} | Marge: ${p.tauxMarge.toFixed(1)}% | PMV: ${pmv.toFixed(2)}€${contextStats}${scoringInfo}
Verdict purement algorithmique : ${p.scoring?.decision || "Non calculé"}${contextRules}

Génère UNIQUEMENT le JSON :`;
    }

    // -----------------------------------------------------------------------
    // Utilitaires de parsing (inchangés)
    // -----------------------------------------------------------------------

    static extractRecommendation(content: string): "A" | "C" | "Z" | null {
        const match = content.match(/\b([ACZ])\b/i);
        if (match) {
            return match[1].toUpperCase() as "A" | "C" | "Z";
        }
        return null;
    }

    static cleanInsight(content: string): string {
        let cleaned = content;
        cleaned = cleaned.replace(/^\[?[ACZ]\]?\s*[:\s-]+\s*/i, "");
        cleaned = cleaned.replace(
            /^(justification|explication|pourquoi|justification courte|raison|avis)\s*[:\s-]+\s*/i,
            ""
        );
        return cleaned.trim();
    }
}
