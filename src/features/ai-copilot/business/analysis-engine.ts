/**
 * CollectFlow — Analysis Engine v6
 *
 * TypeScript fait le calcul, l'IA fait le jugement.
 * Les cas déterministes (stock mort, 0 ventes) sont traités AVANT l'IA.
 * L'IA reçoit un verdict pré-calculé et des signaux pré-calculés.
 */

import type { ProductAnalysisInput, SiteMonthlyData } from "../models/ai-analysis.types";
import type { ProductContextProfile } from "./context-profiler";

export class AnalysisEngine {
    // -----------------------------------------------------------------------
    // SYSTEM PROMPT v6
    // -----------------------------------------------------------------------

    static generateSystemPrompt(): string {
        return `Tu es Mary, Senior Retail Strategist pour une enseigne discount d'équipement de la maison (type La Foir'Fouille).
Tu analyses des produits d'un même fournisseur pour recommander A (garder) ou Z (sortir).

⚠️ IMPORTANT : Les produits sans vente et ceux avec CA < 100€ ET quantité < 30 ont DÉJÀ été
classés Z automatiquement et ne te sont PAS soumis. N'applique PAS de règle de stock mort.

📦 STOCK NÉGATIF : Un stock négatif = commande validée après mise en vente (normal en retail).
Ne pas pénaliser.

--- RÈGLE 1 : RÈGLE MANAGER (PRIORITÉ ABSOLUE) ---
Si une section "RÈGLE MANAGER" est présente dans le message :
→ Détermine si CE produit est concerné par la règle
→ Si OUI : rule_applies = true, applique EXACTEMENT la consigne (A, B, C, D ou Z)
→ Si NON : rule_applies = false, passe à la Règle 2
→ IMPORTANT : Si la règle demande explicitement une Gamme B, C ou D, tu DOIS recommander B, C ou D (pas A ni Z).

Si AUCUNE règle manager n'est fournie → Passer directement à la Règle 2.

--- RÈGLE 2 : CONFIRMATION OU AJUSTEMENT DU VERDICT ---
Chaque produit arrive avec un SCORE (0-100) et un VERDICT pré-calculé (A ou Z).
Ce verdict est ta base de départ. Tu peux l'ajuster UNIQUEMENT dans ces cas :

PROMOUVOIR (Z → A) : Le verdict pré-calculé est Z, MAIS :
  • Tendance en forte accélération (H2/H1 > 2.0)
  • ET réapprovisionnement récent (réceptions 3 derniers mois > 0)
  • ET score ≥ 35
  → Les 3 conditions doivent être remplies SIMULTANÉMENT.

DÉGRADER (A → Z) : Le verdict pré-calculé est A, MAIS :
  • Tendance en effondrement (H2/H1 < 0.4)
  • ET aucune réception récente
  • ET score < 55 ⚠️ SI LE SCORE EST ≥ 55, TU NE PEUX JAMAIS DÉGRADER EN Z
  → Les 3 conditions doivent être remplies SIMULTANÉMENT.
  → Un score élevé (≥ 55) INTERDIT toute dégradation, quelle que soit la tendance.

Si AUCUNE condition d'ajustement n'est remplie → CONFIRME le verdict pré-calculé.

--- RÈGLE 3 : INFORMATIONS CONTEXTUELLES ---
Note dans la justification (sans changer la décision) :
• Si un magasin représente ≥ 80% des ventes → "porté par [magasin]"
• Si produit protégé (nouveauté, dernière ref fournisseur) → le mentionner
• Si un RANKING est fourni, mentionne la position et le percentile du produit (ex: "classé 45e / 5 000 produits, top 1%")
  → Le ranking est un signal contextuel qui RENFORCE le verdict :
    - Top 5% du réseau → signal fort pour garder en A
    - Top 20% du réseau → signal modéré pour garder en A
    - Bottom 30% du réseau → signal défavorable, cohérent avec Z
  → Le ranking seul ne change PAS le verdict, mais combiné avec d'autres signaux il peut justifier un ajustement

--- FORMAT OBLIGATOIRE ---
JSON uniquement, sans markdown.
{
  "rule_applies": boolean,
  "recommendation": "A" | "B" | "C" | "D" | "Z",
  "justification": "2-3 phrases max. Cite le score et le signal clé."
}

IMPORTANT — Gammes disponibles :
- A : Garder (performance correcte)
- B : Gamme secondaire (uniquement si RÈGLE MANAGER l'ordonne)
- C : Gamme saisonnière (uniquement si RÈGLE MANAGER l'ordonne)
- D : Gamme à surveiller (uniquement si RÈGLE MANAGER l'ordonne)
- Z : Sortir (sous-performance)

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
    // Message contextuel enrichi (v6 — verdict pré-calculé)
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
        if (p.prixVente) {
            lines.push(`PRIX VENTE : ${p.prixVente.toFixed(2)}€`);
        }
        lines.push("");

        // ⚠️ RÈGLE MANAGER EN PRIORITÉ 1
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
            lines.push(`   - IGNORE complètement la Règle 2`);
            lines.push(`3. Si NON :`);
            lines.push(`   - rule_applies = false`);
            lines.push(`   - Applique la Règle 2 normalement`);
            lines.push(`═══════════════════════════════════════════════════════════════`);
            lines.push("");
        }

        // Verdict pré-calculé
        const score = p.scoring?.score ?? p.score ?? 0;
        const verdict = p.scoring?.verdict ?? (score >= 45 ? "A" : "Z");
        const quadrant = ctx.quadrantLabel || p.scoring?.quadrant || "N/A";

        lines.push(`--- VERDICT PRÉ-CALCULÉ ---`);
        lines.push(`• Score : ${score}/100`);
        lines.push(`• Verdict : ${verdict}`);
        lines.push(`• Quadrant : ${ctx.quadrantEmoji} ${quadrant}`);
        if (ctx.isProtected) {
            lines.push(`• ⚠️ Protection : ${ctx.protectionReason}`);
        }
        lines.push("");

        // Performance
        const upsm = p.unitsPerStorePerMonth ?? (ctx.qtyPerStore / Math.max(ctx.regularityScore, 3));
        const cpsm = (ctx.caPerStore / 12);

        lines.push(`--- PERFORMANCE ---`);
        lines.push(`• CA réseau : ${ctx.totalCaRaw.toLocaleString('fr-FR')}€ (${cpsm.toFixed(1)}€/mag/mois)`);
        lines.push(`• Quantité : ${ctx.totalQtyRaw} unités (${upsm.toFixed(2)} uté/mag/mois)`);
        lines.push(`• Marge : ${ctx.tauxMarge.toFixed(1)}%`);
        lines.push(`• Régularité : ${ctx.regularityScore}/12 mois actifs`);
        lines.push("");

        // Position dans le lot
        lines.push(`--- POSITION DANS LE LOT (${ctx.lotSize} produits) ---`);
        lines.push(`• Percentile CA : ${ctx.percentileCa}e`);
        lines.push(`• Percentile Volume : ${ctx.percentileQty}e`);
        lines.push(`• Poids CA fournisseur : ${ctx.weightCaFournisseur.toFixed(1)}%`);
        lines.push("");

        // Ranking réseau & magasin (avec percentile contextuel)
        if (p.rankingCa != null || p.rankingQte != null || p.rankingMagCa != null || p.rankingMagQte != null) {
            const total = p.totalRankedProducts ?? 0;
            const totalLabel = total > 0 ? ` / ${total.toLocaleString('fr-FR')} produits` : "";
            lines.push(`--- RANKING RÉSEAU (${total > 0 ? total.toLocaleString('fr-FR') : "?"} produits vendus sur la période) ---`);
            if (p.rankingCa != null) {
                const pctCa = total > 0 ? ((p.rankingCa / total) * 100).toFixed(1) : "?";
                lines.push(`• Classement CA réseau : ${p.rankingCa}e${totalLabel} (top ${pctCa}%)`);
            }
            if (p.rankingQte != null) {
                const pctQte = total > 0 ? ((p.rankingQte / total) * 100).toFixed(1) : "?";
                lines.push(`• Classement Qté réseau : ${p.rankingQte}e${totalLabel} (top ${pctQte}%)`);
            }
            if (p.rankingMagCa != null) lines.push(`• Classement CA magasin : ${p.rankingMagCa}e`);
            if (p.rankingMagQte != null) lines.push(`• Classement Qté magasin : ${p.rankingMagQte}e`);
            lines.push(`• Contexte : ce fournisseur a ${ctx.lotSize} produits dans le lot analysé`);
            lines.push("");
        }

        // Signaux pré-calculés (si données mensuelles disponibles)
        if (p.siteMonthlyData && p.siteMonthlyData.length > 0) {
            const signals = AnalysisEngine.computeSignals(p.siteMonthlyData);

            lines.push(`--- SIGNAUX ---`);
            lines.push(`• Tendance : ${signals.tendanceLabel}`);
            lines.push(`• Réapprovisionnement : ${signals.reappLabel}`);
            if (signals.asymLabel) {
                lines.push(`• Asymétrie magasins : ${signals.asymLabel}`);
            }
            lines.push(`• Inactivité : ${ctx.inactivityMonths} mois sans vente en fin de fenêtre`);
            lines.push("");
        }

        // Stock & approvisionnement
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
    // Calcul des signaux à partir des données mensuelles
    // -----------------------------------------------------------------------

    private static computeSignals(siteMonthlyData: SiteMonthlyData[]): {
        tendanceLabel: string;
        reappLabel: string;
        asymLabel: string;
    } {
        const sortedMonths = [...new Set(siteMonthlyData.map(r => r.mois))].sort();
        const midIdx = Math.floor(sortedMonths.length / 2);
        const h1Months = new Set(sortedMonths.slice(0, midIdx));
        const h2Months = new Set(sortedMonths.slice(midIdx));
        const last3Months = new Set(sortedMonths.slice(-3));

        let h1Qty = 0, h2Qty = 0;
        const qteBySite: Record<string, number> = {};
        let recentReceptions = 0;
        let recentSales = 0;

        for (const r of siteMonthlyData) {
            if (h1Months.has(r.mois)) h1Qty += r.ventes_qte;
            if (h2Months.has(r.mois)) h2Qty += r.ventes_qte;
            qteBySite[r.site] = (qteBySite[r.site] ?? 0) + r.ventes_qte;
            if (last3Months.has(r.mois)) {
                recentReceptions += r.receptions_qte;
                recentSales += r.ventes_qte;
            }
        }

        const tendanceRatio = h1Qty > 0 ? h2Qty / h1Qty : (h2Qty > 0 ? Infinity : 1);

        // Signal tendance
        let tendanceLabel: string;
        if (h1Qty === 0 && h2Qty > 0) {
            tendanceLabel = `Produit entrant (H1: 0 → H2: ${h2Qty} uté) — premières ventes récentes`;
        } else if (tendanceRatio < 0.4) {
            tendanceLabel = `Effondrement (H1: ${h1Qty} uté → H2: ${h2Qty} uté, ratio ${tendanceRatio.toFixed(2)})`;
        } else if (tendanceRatio > 2.0) {
            tendanceLabel = `Accélération forte (H1: ${h1Qty} uté → H2: ${h2Qty} uté, ratio ${tendanceRatio.toFixed(2)})`;
        } else {
            tendanceLabel = `Stable (H1: ${h1Qty} uté → H2: ${h2Qty} uté, ratio ${tendanceRatio.toFixed(2)})`;
        }

        // Signal réapprovisionnement
        const reappLabel = recentReceptions > 0
            ? `Réceptions récentes : ${recentReceptions} uté reçues sur les 3 derniers mois`
            : (recentSales === 0
                ? "Aucune réception ni vente sur les 3 derniers mois"
                : "Aucune réception récente (ventes encore actives)");

        // Signal asymétrie
        const totalQte = Object.values(qteBySite).reduce((a, b) => a + b, 0);
        const sites = Object.entries(qteBySite);
        let asymLabel = "";
        if (sites.length >= 2 && totalQte > 0) {
            const dominant = sites.sort((a, b) => b[1] - a[1])[0];
            const pct = Math.round((dominant[1] / totalQte) * 100);
            if (pct >= 80) {
                asymLabel = `Porté par ${dominant[0]} (${pct}% des ventes)`;
            }
        }

        return { tendanceLabel, reappLabel, asymLabel };
    }

    // -----------------------------------------------------------------------
    // Fallback legacy (sans contextProfile)
    // -----------------------------------------------------------------------

    private static buildLegacyMessage(p: ProductAnalysisInput): string {
        const score = p.scoring?.score ?? p.score ?? 0;
        const verdict = p.scoring?.verdict ?? (score >= 45 ? "A" : "Z");
        const pmv = p.totalQuantite > 0 ? p.totalCa / p.totalQuantite : 0;

        const contextRules = p.supplierContext
            ? `\n--- RÈGLE MANAGER ---\n"${p.supplierContext}"\n→ Évalue si le produit ("${p.libelle1}") est concerné. rule_applies = true/false.\n`
            : "";

        return `PRODUIT : ${p.libelle1} (${p.codein})
Famille / Rayon : ${p.libelleNiveau2 ?? "N/A"}

--- VERDICT PRÉ-CALCULÉ ---
• Score : ${score}/100
• Verdict : ${verdict}

--- PERFORMANCE ---
• CA réseau : ${p.totalCa.toFixed(2)}€
• Quantité : ${p.totalQuantite} unités
• Marge : ${p.tauxMarge.toFixed(1)}%
• PMV : ${pmv.toFixed(2)}€
${p.shareCa !== undefined ? `• Poids CA Fournisseur : ${p.shareCa.toFixed(1)}%` : ""}
${p.rankingCa != null || p.rankingQte != null ? `\n--- RANKING ---\n${p.rankingCa != null ? `• Classement CA réseau : ${p.rankingCa}e${p.totalRankedProducts ? ` / ${p.totalRankedProducts} produits (top ${((p.rankingCa / p.totalRankedProducts) * 100).toFixed(1)}%)` : ""}\n` : ""}${p.rankingQte != null ? `• Classement Qté réseau : ${p.rankingQte}e${p.totalRankedProducts ? ` / ${p.totalRankedProducts} produits (top ${((p.rankingQte / p.totalRankedProducts) * 100).toFixed(1)}%)` : ""}\n` : ""}${p.rankingMagCa != null ? `• Classement CA magasin : ${p.rankingMagCa}e\n` : ""}${p.rankingMagQte != null ? `• Classement Qté magasin : ${p.rankingMagQte}e` : ""}` : ""}${contextRules}
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
