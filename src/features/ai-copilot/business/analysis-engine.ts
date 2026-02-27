/**
 * CollectFlow — Analysis Engine (v4 — Anti sur-classement)
 *
 * v4 — Correctifs :
 *  - Suppression des prescriptions directes "→ A" dans le guide des quadrants.
 *  - Ajout du seuil plancher absolu : contribution insignifiante + score faible → Z.
 *  - Affichage du signal isLowContribution en rouge dans le message.
 *  - Les quadrants sont des INDICES, pas des verdicts. Mary doit croiser avec les poids.
 */

import type { ProductAnalysisInput } from "../models/ai-analysis.types";
import type { ProductContextProfile } from "./context-profiler";

export class AnalysisEngine {
    // -----------------------------------------------------------------------
    // SYSTEM PROMPT v4
    // -----------------------------------------------------------------------

    static generateSystemPrompt(): string {
        return `Tu es Mary, Senior Retail Strategist. Tu analyses des produits pour recommander A (garder), C (saisonnier), ou Z (sortir).

--- ORDRE DE PRIORITÉ (STRICT) ---

1. GARDE-FOU PROTECTION : Si isProtected = true (Nouveauté / Dernier Produit / Top30) → A obligatoire.

2. SEUIL PLANCHER ABSOLU (règle critique) :
   Si isLowContribution = true [poids CA < 0.5% ET poids QTÉ < 0.5% du fournisseur]
   ET score composite < 35
   ET scoreCritique = true [score brut < 20]
   → Z DIRECT. Ce produit est marginal et sous-performant. Aucun signal ne peut l'annuler.

3. RÈGLE MANAGER : Si le manager a défini une consigne ET que le produit est concerné → Appliquer.

4. ANALYSE CONTEXTUELLE (si aucune règle ci-dessus ne s'applique) :
   Utilise les données de la fiche pour raisonner. Les quadrants sont des INDICES, pas des verdicts.

   — Quadrant STAR ⭐ : Fort signal positif. A sauf inactivité ≥ 3 mois.
   — Quadrant TRAFIC 🚶 : Signal positif SEULEMENT si poids QTÉ fournisseur > 1%.
     Si poids < 1% et score < 40 → tendance Z ou C.
   — Quadrant MARGE 💎 : Signal positif SEULEMENT si poids CA fournisseur > 0.5%.
     Si poids < 0.5% et score < 35 → tendance Z.
   — Quadrant WATCH ⚠️ : Signal négatif par défaut.
     Si poids CA rayon > 5% ou poids QTÉ rayon > 5% → A ou C selon inactivité.
     Sinon → Z si inactivité ≥ 2 mois, C si 1 mois, A si actif mais surveiller.

--- COHÉRENCE INTER-PRODUITS ---
Ne mets jamais Z un produit si son percentile CA ET son percentile QTÉ sont tous les deux supérieurs à un autre produit déjà classé A dans ce lot.

--- FORMAT OBLIGATOIRE ---
JSON uniquement, sans markdown.
{
  "rule_applies": boolean,
  "recommendation": "A" | "C" | "Z",
  "justification": "2 phrases max. Cite poids, percentile, quadrant, score."
}`;
    }

    // -----------------------------------------------------------------------
    // USER MESSAGE
    // -----------------------------------------------------------------------

    static generateUserMessage(p: ProductAnalysisInput): string {
        if (p.contextProfile) {
            return AnalysisEngine.buildContextualMessage(p, p.contextProfile);
        }
        return AnalysisEngine.buildLegacyMessage(p);
    }

    // -----------------------------------------------------------------------
    // Message contextuel enrichi (v4)
    // -----------------------------------------------------------------------

    private static buildContextualMessage(
        p: ProductAnalysisInput,
        ctx: ProductContextProfile
    ): string {
        const lines: string[] = [];

        lines.push(`PRODUIT : ${ctx.libelle1} (${ctx.codein})`);
        lines.push(`CATÉGORIE : ${ctx.libelleNiveau2} (rayon: ${ctx.rayonSize} produits | lot total: ${ctx.lotSize} produits)`);
        lines.push("");

        // Quadrant — présenté comme un indice, sans prescription
        lines.push(`--- PROFIL QUADRANT (indice, pas un verdict) ---`);
        lines.push(`${ctx.quadrantEmoji} ${ctx.quadrantLabel}`);
        lines.push(`Santé : ${ctx.regularityScore}/12 mois actifs | ${ctx.inactivityMonths} mois sans vente | Marge : ${ctx.tauxMarge.toFixed(1)}%`);
        lines.push("");

        // Position / poids — données brutes
        lines.push(`--- POSITION DANS LE LOT FOURNISSEUR ---`);
        lines.push(`• CA       : ${ctx.percentileCa}e percentile | Poids fournisseur : ${ctx.weightCaFournisseur}% | Poids rayon N2 : ${ctx.weightCaRayon}%`);
        lines.push(`• Quantité : ${ctx.percentileQty}e percentile | Poids fournisseur : ${ctx.weightQtyFournisseur}% | Poids rayon N2 : ${ctx.weightQtyRayon}%`);
        lines.push(`• Marge    : ${ctx.percentileMarge}e percentile`);
        lines.push(`• Score composite : ${ctx.percentileComposite}/100`);
        lines.push("");

        // Signaux — tous présentés factuellement, sans recommandation inline
        lines.push(`--- SIGNAUX ---`);

        // Signal rouge prioritaire
        if (ctx.isLowContribution) {
            lines.push(`[⛔ CONTRIBUTION FAIBLE] Poids CA : ${ctx.weightCaFournisseur}% et Poids QTÉ : ${ctx.weightQtyFournisseur}% → produit marginal pour le fournisseur`);
        }
        if (ctx.scoreCritique) {
            lines.push(`[⛔ SCORE CRITIQUE] Score brut < 20 → sous-seuil absolu`);
        }

        // Signaux positifs
        lines.push(`${ctx.isTop20Ca ? "[✓]" : "[ ]"} Top 20% CA fournisseur`);
        lines.push(`${ctx.isTop20Qty ? "[✓]" : "[ ]"} Top 20% Quantités fournisseur`);
        lines.push(`${ctx.isHighVolumeWithLowMargin ? "[✓]" : "[ ]"} Fort volume (> P60 lot) avec marge faible`);
        lines.push(`${ctx.isMargePure ? "[✓]" : "[ ]"} Forte marge (> P70 lot) malgré volume faible`);
        lines.push(`${ctx.isAboveMedianComposite ? "[✓]" : "[ ]"} Au-dessus de la médiane composite`);
        if (!ctx.isHighVolumeWithLowMargin && !ctx.isMargePure) {
            lines.push(`[i] Signaux Trafic/Marge non activés (rayon de ${ctx.rayonSize} produits${ctx.rayonSize < 6 ? " — trop petit pour stats fiables" : ""})`);
        }
        lines.push("");

        // Protection
        if (ctx.isProtected) {
            lines.push(`🛡️ GARDE-FOU : ${ctx.protectionReason} → A obligatoire`);
            lines.push("");
        }

        // Règle manager
        if (p.supplierContext) {
            lines.push(`--- RÈGLE MANAGER ---`);
            lines.push(`"${p.supplierContext}"`);
            lines.push(`→ Ce produit ("${ctx.libelle1}") est-il concerné ? rule_applies = true/false.`);
            lines.push("");
        }

        lines.push(`Génère UNIQUEMENT le JSON :`);
        return lines.join("\n");
    }

    // -----------------------------------------------------------------------
    // Fallback legacy
    // -----------------------------------------------------------------------

    private static buildLegacyMessage(p: ProductAnalysisInput): string {
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        let contextStats = "";
        if (p.shareCa !== undefined && p.shareQty !== undefined) {
            contextStats += `\nPOIDS DU PRODUIT :
- Poids Fournisseur (CA) : ${p.shareCa.toFixed(1)}%
- Poids Secteur/Rayon (Quantité) : ${p.shareQty.toFixed(1)}%`;
        }

        const scoringInfo = p.scoring
            ? `\n--- RÉSULTATS DÉCISION RAYON ---
    INDICE RAYON: ${p.scoring.compositeScore}/100 (Seuil Z : ${p.scoring.threshold})
    PROFIL: ${p.scoring.labelProfil}
    GARDES-FOUS : Top30: ${p.scoring.isTop30Supplier ? "Oui" : "Non"} | Récent: ${p.scoring.isRecent ? "Oui" : "Non"} | Dernier: ${p.scoring.isLastProduct ? "Oui" : "Non"}
`
            : "";

        const contextRules = p.supplierContext
            ? `\n--- RÈGLE MANAGER ---\n"${p.supplierContext}"\n→ Évalue si le produit ("${p.libelle1}") est concerné. rule_applies = true/false.\n`
            : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
Famille / Rayon : ${p.libelleNiveau2}
Score Algorithmique : ${p.score.toFixed(1)}/100
KPIs : CA: ${p.totalCa.toFixed(2)}€ | Qté: ${p.totalQuantite} | Marge: ${p.tauxMarge.toFixed(1)}% | PMV: ${pmv.toFixed(2)}€${contextStats}${scoringInfo}${contextRules}
Génère UNIQUEMENT le JSON :`;
    }

    // -----------------------------------------------------------------------
    // Utilitaires de parsing (inchangés)
    // -----------------------------------------------------------------------

    static extractRecommendation(content: string): "A" | "C" | "Z" | null {
        const match = content.match(/\b([ACZ])\b/i);
        if (match) return match[1].toUpperCase() as "A" | "C" | "Z";
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
