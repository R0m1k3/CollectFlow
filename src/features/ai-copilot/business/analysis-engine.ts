/**
 * CollectFlow — Analysis Engine (v5 — SIMPLIFIÉ)
 *
 * Version simplifiée basée sur la performance relative au fournisseur.
 * Principe: Tout est relatif à la moyenne du lot fournisseur.
 */

import type { ProductAnalysisInput } from "../models/ai-analysis.types";
import type { ProductContextProfile } from "./context-profiler";

export class AnalysisEngine {
    // -----------------------------------------------------------------------
    // SYSTEM PROMPT v5 — SIMPLIFIÉ
    // -----------------------------------------------------------------------

    static generateSystemPrompt(): string {
        return `Tu es Mary, Senior Retail Strategist pour une enseigne discount d'équipement de la maison (type La Foir'Fouille).
Ton modèle économique repose sur la rotation rapide, le volume, et la rentabilité de l'espace en rayon.
Tu analyses des produits pour recommander A (garder) ou Z (sortir).

--- ORDRE DE PRIORITÉ (STRICT) ---

📝 RÈGLE 1 — RÈGLE MANAGER (PRIORITÉ ABSOLUE):
Si une règle manager est définie (section "RÈGLE MANAGER" dans le message) ET que le produit est concerné:
→ Appliquer la consigne À LA LETTRE, même si elle contredit les autres règles.
→ Mettre rule_applies = true et suivre EXACTEMENT la recommandation de la règle (A, B, C, D ou Z).
→ Les règles 2 et 3 ci-dessous NE S'APPLIQUENT PAS si une règle manager est active.
→ IMPORTANT : Si la règle demande explicitement une Gamme B, C ou D, tu DOIS recommander B, C ou D (pas A ni Z).

Si AUCUNE règle manager n'est fournie → Passer directement aux règles 2 et 3.

⛔ RÈGLE 2 — STOCK MORT ABSOLU:
SI CA réseau < 100€ ET Quantité réseau < 30 unités SIMULTANÉMENT → Z IMMÉDIAT, STOP.
Les DEUX conditions doivent être vraies en même temps.
Un produit à 30€ de CA sur 2 magasins (15€/magasin/an) coûte plus en gestion qu'il ne rapporte.

📊 RÈGLE 3 — PERFORMANCE RELATIVE AU FOURNISSEUR:
Le produit doit être évalué PAR RAPPORT à la moyenne de son lot fournisseur.

ÉTAPE 1: Calculer la moyenne du lot
  CA Moyen Fournisseur = CA Total Fournisseur ÷ Nombre de produits

ÉTAPE 2: Calculer le score relatif du produit
  Score Relatif = (CA Produit ÷ CA Moyen) × 100

ÉTAPE 3: Décider selon le score
  • Si Score ≥ 100 → Le produit fait AU MOINS sa part → A
  • Si Score ≥ 50 ET < 100 → Le produit fait entre 50% et 100% de sa part → Comparer au percentile médian (P50)
    - Si percentile CA ≥ 50 → A (médiane ou mieux)
    - Si percentile CA < 50 → Z (sous la médiane)
  • Si Score < 50 → Le produit fait moins de la moitié de sa part → Z

RATIONALE : Cette logique s'adapte automatiquement à TOUS les fournisseurs:
- Petit fournisseur (5 produits) : moyenne élevée, mais comparaison équitable
- Gros fournisseur (50 produits) : moyenne faible, mais comparaison équitable
- Même score relatif = même décision, indépendamment de la taille du fournisseur

--- FORMAT OBLIGATOIRE ---
JSON uniquement, sans markdown.
{
  "rule_applies": boolean,
  "recommendation": "A" | "B" | "C" | "D" | "Z",
  "justification": "2-3 phrases max. Cite le score relatif et/ou les seuils absolus."
}

IMPORTANT — Gammes disponibles :
- A : Garder (recommandation par défaut si performance correcte)
- B : Gamme secondaire (uniquement si RÈGLE MANAGER l'ordonne explicitement)
- C : Gamme saisonnière (uniquement si RÈGLE MANAGER l'ordonne explicitement)
- D : Gamme à surveiller (uniquement si RÈGLE MANAGER l'ordonne explicitement)
- Z : Sortir (si sous-performance ou stock mort)

SI AUCUNE RÈGLE MANAGER n'est définie, tu recommandes UNIQUEMENT A ou Z (jamais B, C, D spontanément).`;
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
    // Message contextuel enrichi (v5 simplifié)
    // -----------------------------------------------------------------------

    private static buildContextualMessage(
        p: ProductAnalysisInput,
        ctx: ProductContextProfile
    ): string {
        const lines: string[] = [];
        const storeLabel = ctx.storeCount > 1 ? `${ctx.storeCount} magasins` : `1 magasin`;

        // En-tête produit
        lines.push(`PRODUIT : ${ctx.libelle1} (${ctx.codein})`);
        lines.push(`CATÉGORIE : ${ctx.libelleNiveau2}`);
        lines.push(`DISTRIBUTION : ${storeLabel}`);
        lines.push("");

        // ⚠️ RÈGLE MANAGER EN PRIORITÉ 1 — doit être visible AVANT toute analyse
        if (p.supplierContext) {
            lines.push(`🎯 ═══════════════════════════════════════════════════════════════`);
            lines.push(`🎯 🎯 🎯      RÈGLE MANAGER (PRIORITÉ ABSOLUE)      🎯 🎯 🎯`);
            lines.push(`═══════════════════════════════════════════════════════════════`);
            lines.push(``);
            lines.push(`RÈGLE DÉFINIE PAR LE MANAGER :`);
            lines.push(`"${p.supplierContext}"`);
            lines.push(``);
            lines.push(`PRODUIT ANALYSÉ : "${ctx.libelle1}"`);
            lines.push(`CATÉGORIE : ${ctx.libelleNiveau2}`);
            lines.push(``);
            lines.push(`⚠️ INSTRUCTION CRITIQUE :`);
            lines.push(`1. Analyse si CE produit est concerné par la règle ci-dessus`);
            lines.push(`2. Si OUI :`);
            lines.push(`   - rule_applies = true`);
            lines.push(`   - Applique EXACTEMENT la consigne (si la règle dit "Gamme B", tu DOIS mettre "B")`);
            lines.push(`   - IGNORE complètement les règles 2 et 3 (performance, stock mort, etc.)`);
            lines.push(`3. Si NON :`);
            lines.push(`   - rule_applies = false`);
            lines.push(`   - Applique les règles 2-3 normalement`);
            lines.push(`═══════════════════════════════════════════════════════════════`);
            lines.push("");
        }

        // KPIs bruts
        lines.push(`--- PERFORMANCE ABSOLUE ---`);
        lines.push(`• CA réseau : ${ctx.totalCaRaw.toLocaleString('fr-FR')}€`);
        lines.push(`• Quantité réseau : ${ctx.totalQtyRaw} unités`);
        lines.push(`• Marge : ${ctx.tauxMarge.toFixed(1)}%`);
        lines.push("");

        // Contexte fournisseur
        // Calcul du CA total fournisseur à partir du poids
        const totalFournisseurCa = ctx.weightCaFournisseur > 0
            ? ctx.totalCaRaw / (ctx.weightCaFournisseur / 100)
            : 0;
        const caMoyenAttendu = ctx.lotSize > 0 ? totalFournisseurCa / ctx.lotSize : 0;

        lines.push(`--- CONTEXTE FOURNISSEUR ---`);
        lines.push(`• Lot fournisseur : ${ctx.lotSize} produits`);
        lines.push(`• CA moyen attendu : ${caMoyenAttendu.toFixed(0)}€ par produit`);
        lines.push(`• Poids CA de ce produit : ${ctx.weightCaFournisseur.toFixed(1)}% du CA total fournisseur`);
        lines.push(`• Percentile CA : ${ctx.percentileCa}e percentile (position dans le lot)`);
        lines.push("");

        // Score relatif calculé
        const scoreRelatif = ctx.weightCaFournisseur * ctx.lotSize; // weight% × nb produits = score relatif
        lines.push(`--- SCORE RELATIF ---`);
        lines.push(`• Score Relatif : ${scoreRelatif.toFixed(0)} (100 = fait exactement sa part)`);
        lines.push(`  → ${scoreRelatif >= 100 ? "✓ Au-dessus de la moyenne" : scoreRelatif >= 50 ? "⚠️ Entre 50% et 100% de la moyenne" : "✗ Très en dessous de la moyenne"}`);
        lines.push("");

        // Bloc stock & approvisionnement (si données disponibles)
        const hasStockData = ctx.stockCoverage !== undefined || ctx.isLowStock || ctx.isDeadInventory || ctx.isCommandeEnCours;
        if (hasStockData) {
            lines.push(`--- STOCK & APPROVISIONNEMENT ---`);
            if (ctx.stockCoverage > 0) {
                lines.push(`• Couverture stock : ${ctx.stockCoverage.toFixed(1)} mois de ventes en stock`);
            }
            if (ctx.isLowStock) {
                lines.push(`• ⚠️ Stock faible : moins d'un PCB disponible`);
            }
            if (ctx.isDeadInventory) {
                lines.push(`• ⚠️ Stock dormant : pas de vente depuis > 90 jours`);
            }
            if (ctx.isCommandeEnCours) {
                lines.push(`• Commande en cours : réapprovisionnement prévu`);
            }
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
- Poids CA Fournisseur : ${p.shareCa.toFixed(1)}%`;
        }

        const contextRules = p.supplierContext
            ? `\n--- RÈGLE MANAGER ---\n"${p.supplierContext}"\n→ Évalue si le produit ("${p.libelle1}") est concerné. rule_applies = true/false.\n`
            : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
Famille / Rayon : ${p.libelleNiveau2}
KPIs : CA: ${p.totalCa.toFixed(2)}€ | Qté: ${p.totalQuantite} | Marge: ${p.tauxMarge.toFixed(1)}% | PMV: ${pmv.toFixed(2)}€${contextStats}${contextRules}
Génère UNIQUEMENT le JSON :`;
    }

    // -----------------------------------------------------------------------
    // Utilitaires de parsing
    // -----------------------------------------------------------------------

    static extractRecommendation(content: string): "A" | "B" | "C" | "D" | "Z" | null {
        const match = content.match(/\b([ABCDZ])\b/i);
        if (match) return match[1].toUpperCase() as "A" | "B" | "C" | "D" | "Z";
        return null;
    }

    static cleanInsight(content: string): string {
        let cleaned = content;
        cleaned = cleaned.replace(/^\[?[ABCDZ]\]?\s*[:\s-]+\s*/i, "");
        cleaned = cleaned.replace(
            /^(justification|explication|pourquoi|justification courte|raison|avis)\s*[:\s-]+\s*/i,
            ""
        );
        return cleaned.trim();
    }
}
