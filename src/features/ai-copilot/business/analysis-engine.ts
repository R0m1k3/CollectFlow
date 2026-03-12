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
        return `Tu es Mary, Senior Retail Strategist pour une enseigne discount d'équipement de la maison (type La Foir'Fouille). Ton modèle économique repose sur la rotation rapide, le volume, et la rentabilité de l'espace en rayon. Tu analyses des produits pour recommander A (garder) ou Z (sortir).
IMPORTANT : La gamme C est RÉSERVÉE aux produits saisonniers et gérée MANUELLEMENT par l'acheteur. Tu ne dois JAMAIS recommander C.

--- ORDRE DE PRIORITÉ (STRICT) ---

⛔ VÉRIFICATION OBLIGATOIRE EN PREMIER ⛔
Avant toute autre analyse, VÉRIFIER systématiquement si le produit est un STOCK MORT ABSOLU:
SI CA réseau < 100€ ET Quantité réseau < 30 unités → Z IMMÉDIAT, ne pas continuer l'analyse, STOP.
Cette règle PRIME sur toutes les autres (protection, star, haute valeur, locomotive, complémentarité, etc.).

1. GARDE-FOU PROTECTION FORTE : Si isProtected = true (Nouveauté / Dernier Produit / Top30), c'est un signal FORT en faveur de A.
   Cependant, si les performances réelles du produit sont clairement insuffisantes (CA dérisoire, marge nulle ou négative), tu PEUX passer outre la protection et recommander Z avec justification.

2. QUADRANT STAR — PROTECTION ABSOLUE : Si le produit est en quadrant STAR (volume élevé ET marge élevée), c'est un produit STRATÉGIQUE qui génère à la fois du volume et de la rentabilité.
   → GARDE en A automatiquement.

3. PROTECTION PRODUITS HAUTE VALEUR FACIALE (PMV élevé) :
   Si le produit génère un CA significatif MALGRÉ un faible volume, c'est un produit à forte valeur faciale (PMV élevé = CA/Quantité élevé).
   Ces produits optimisent la rentabilité par m² car ils génèrent du CA et de la marge avec peu d'espace rayon.
   → Si CA total réseau ≥ 200€ → GARDE en A, même si quantité < 50 unités.
   RATIONALE : Un produit qui vend 40 unités à 5€ (200€ CA) est MEILLEUR qu'un produit qui vend 200 unités à 0.80€ (160€ CA).
   Le PMV élevé = optimisation espace rayon + meilleure rentabilité.

4. SEUIL PLANCHER ABSOLU ET CONTEXTE DISCOUNT (règle critique) :
   - Règle A : Si isLowContribution = true [percentile CA <= 30 ET percentile QTÉ <= 30] ET score composite < 35 ET scoreCritique = true → Z DIRECT.
   - Règle B (⛔ STOCK MORT ABSOLU — RÈGLE NON-NÉGOCIABLE ⛔) :
     SI CA réseau < 100€ ET Quantité réseau < 30 unités SIMULTANÉMENT:
       → Z OBLIGATOIRE — AUCUNE EXCEPTION POSSIBLE
       → Ne PAS considérer: complémentarité, assortiment, choix, rupture d'offre, pilier, locomotive, ou toute autre raison
       → RATIONALE ÉCONOMIQUE: Un produit à 30€ de CA sur 2 magasins (15€/magasin/an = 1.25€/mois) coûte PLUS en gestion qu'il ne rapporte
       → Un tel produit ne peut JAMAIS être "indispensable" ou "structurant" — c'est un gaspillage d'espace rayon
     IMPORTANT : Les DEUX conditions doivent être vraies en même temps. Si CA < 100€ MAIS Quantité ≥ 30 → NE PAS appliquer cette règle. Si Quantité < 30 MAIS CA ≥ 100€ → NE PAS appliquer cette règle.
   - Règle C (Locomotive de Rayon — PROTECTION CONDITIONNELLE) : Si isLocomotiveRayon = true [poids CA rayon > 15% OU poids QTÉ rayon > 15%]:
     VÉRIFIER EN PREMIER : Est-ce un stock mort absolu ?
       → SI CA total réseau < 100€ ET Quantité réseau < 30 unités → Z OBLIGATOIRE (rayon mort, fermer la catégorie)
       → SI taille rayon < 3 produits ET CA total rayon < 500€ → Pas de protection locomotive, Z si performances insuffisantes
     SI AUCUNE des conditions ci-dessus :
       → ALORS c'est un VRAI PILIER structurant → GARDE en A
     RATIONALE : Un produit qui fait 20€ de CA même avec 100% du poids n'est pas une locomotive, c'est un rayon à fermer. Une vraie locomotive pèse lourd dans un rayon ACTIF avec plusieurs produits.

5. RÈGLE MANAGER : Si le manager a défini une consigne ET que le produit est concerné → Appliquer la consigne À LA LETTRE.
   Si la règle ordonne explicitement une Gamme B, C ou D, TU DOIS SORTIR "B", "C" ou "D". "rule_applies" doit être 'true'.
   IMPORTANT : Si AUCUNE règle manager n'est fournie dans le contexte ci-dessous, IGNORER complètement cette section et passer directement à l'analyse contextuelle.

6. ANALYSE CONTEXTUELLE (si aucune règle ci-dessus ne s'applique) :
   Les quadrants sont des INDICES pour guider la décision.
   — Quadrant STAR ⭐ : Volume élevé + Marge élevée = Produit stratégique.
     → A AUTOMATIQUE (déjà traité en priorité 2 - cette ligne est informative seulement).
   — Quadrant TRAFIC 🚶 : Générateur de flux (volume élevé, marge faible).
     Si percentileQty >= 60 → A.
     Si percentileQty < 40 ET score < 35 → Z.
     Si CA total réseau ≥ 250€ → A (génère du CA suffisant).
     Si quantité totale réseau ≥ 100 unités → A (volume élevé = générateur de trafic).
     Sinon → A (générateur de trafic utile pour l'assortiment).
   — Quadrant MARGE 💎 : Contributeur rentabilité (volume faible, marge élevée).
     Si percentileMarge >= 70 → A.
     Si percentileMarge < 70 ET score < 35 → Z.
     Si CA total réseau ≥ 300€ OU marge totale ≥ 150€ → A (contribution rentabilité suffisante).
     Sinon → A (produit de marge utile pour la rentabilité globale).
   — Quadrant WATCH ⚠️ : Sous-performant relatif (qty/marge sous médiane).
     Si poids CA fournisseur ≥ 3% OU poids CA rayon ≥ 2% OU poids QTÉ rayon ≥ 2% → A.
     Si CA total réseau ≥ 250€ → A (génère du CA suffisant, peu importe la quantité).
     Si quantité totale réseau ≥ 100 unités ET CA ≥ 150€ → A (volume suffisant avec CA raisonnable).
     Si percentileCa ≥ 50 OU percentileQty ≥ 50 → A (médiane ou mieux dans le lot).
     Sinon → Z pour purger les vrais sous-performeurs.

--- COHÉRENCE INTER-PRODUITS ---
Ne mets jamais Z un produit si son percentile CA ET son percentile QTÉ sont tous les deux supérieurs à un autre produit classé A.
EXCEPTION : Cette règle de cohérence s'annule totalement si le produit est considéré comme un [⛔ STOCK MORT] (chiffres absolus dérisoires). Un stock mort doit toujours sortir en Z.

--- COMPLÉMENTARITÉ ET CHOIX MINIMAL (règle d'assortiment) ---
⛔ IMPORTANT: Cette règle NE S'APPLIQUE PAS si le produit est un STOCK MORT ABSOLU (CA < 100€ ET Qty < 30).
Un produit sous ces seuils est TOUJOURS Z, sans exception, même s'il est le seul de sa catégorie.
Un rayon à 30€/an doit être FERMÉ, pas maintenu pour la complémentarité.

La Foir'Fouille doit offrir un CHOIX COMPLET dans chaque nomenclature pour attirer et fidéliser la clientèle. Certaines catégories génèrent peu de CA mais sont INDISPENSABLES pour l'image "tout sous un même toit".
MAIS: Ceci s'applique UNIQUEMENT aux produits au-dessus des seuils de rentabilité minimale (CA ≥ 100€ OU Qty ≥ 30).

RÈGLE DE COMPLÉMENTARITÉ :
- Si le rayon compte MOINS de 8 produits actifs (non-Z) dans la nomenclature
  ET que le produit analysé n'est PAS un stock mort (CA > 150€ OU QTÉ > 30)
  → GARDE en A pour maintenir un assortiment minimal et éviter une rupture d'offre.

- Si le rayon compte PLUS de 15 produits actifs → Tu peux être sévère et purger les sous-performants sans risquer une rupture de gamme.

GUIDE NOMENCLATURES (à adapter selon contexte) :
• Nomenclatures ESSENTIELLES (CA faible accepté si complémentarité) :
  Arts de la table, Cuisine de base, Rangement, Papeterie, Hygiène, Petit électroménager
  → Objectif : Offrir un choix complet même si rotation faible. Accepte des produits avec percentile CA < 50 si nécessaires pour couvrir les sous-familles.

• Nomenclatures GÉNÉRATRICES DE TRAFIC (volume prioritaire) :
  Décoration, Textile maison, Jardin, Jouets, Loisirs créatifs
  → Objectif : Maximiser le volume et la fréquentation. Privilégie forte rotation même avec marge faible.

• Nomenclatures OPPORTUNISTES (exigence maximale) :
  Saisonnalité forte (Noël, Halloween, Pâques, Barbecue, Piscine)
  → Objectif : Rentabilité pure. Pas de sentimentalisme. Si le produit sous-performe → Z sans hésitation.

--- FORMAT OBLIGATOIRE ---
JSON uniquement, sans markdown.
{
  "rule_applies": boolean,
  "recommendation": "A" | "B" | "C" | "D" | "Z",
  "justification": "2 phrases max. Cite les chiffres absolus si ridicules, ou les percentiles/quadrant."
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
        const storeLabel = ctx.storeCount > 1 ? `${ctx.storeCount} magasins` : `1 magasin`;

        lines.push(`PRODUIT : ${ctx.libelle1} (${ctx.codein})`);
        lines.push(`CATÉGORIE : ${ctx.libelleNiveau2}`);
        lines.push(`CONTEXTE RAYON : ${ctx.rayonSize} produits dans cette nomenclature | Lot fournisseur total: ${ctx.lotSize} produits`);
        lines.push(`DISTRIBUTION : ${storeLabel} référençant ce produit`);

        // Alerte complémentarité si petit rayon
        if (ctx.rayonSize < 8) {
            lines.push(`⚠️ PETIT RAYON : Seulement ${ctx.rayonSize} produits dans cette nomenclature → Risque de rupture d'offre si purge excessive`);
        }
        lines.push("");

        // KPIs bruts réseau + valeurs normalisées par magasin
        lines.push(`--- PERFORMANCE (brute réseau / par magasin) ---`);
        lines.push(`• CA réseau : ${ctx.totalCaRaw.toLocaleString('fr-FR')}€ | CA par magasin : ${ctx.caPerStore.toFixed(0)}€`);
        lines.push(`• Quantité réseau : ${ctx.totalQtyRaw} unités | QTÉ par magasin : ${ctx.qtyPerStore.toFixed(0)} unités`);
        lines.push(`• Marge : ${ctx.tauxMarge.toFixed(1)}%`);
        lines.push(`⚠️ Les percentiles ci-dessous sont calculés sur les valeurs PAR MAGASIN pour comparer équitablement les produits 1-magasin et 2-magasins.`);
        lines.push("");

        // Quadrant — présenté comme un indice, sans prescription
        lines.push(`--- PROFIL QUADRANT (indice, pas un verdict) ---`);
        lines.push(`${ctx.quadrantEmoji} ${ctx.quadrantLabel}`);
        lines.push(`Santé : ${ctx.regularityScore}/12 mois actifs | ${ctx.inactivityMonths} mois sans vente | Marge : ${ctx.tauxMarge.toFixed(1)}%`);
        lines.push("");

        // Position / poids — données brutes
        lines.push(`--- POSITION DANS LE LOT FOURNISSEUR (percentiles sur valeurs par magasin) ---`);
        lines.push(`• CA/magasin   : ${ctx.percentileCa}e percentile | Poids CA réseau fournisseur : ${ctx.weightCaFournisseur}% | Poids CA réseau rayon N2 : ${ctx.weightCaRayon}%`);
        lines.push(`• QTÉ/magasin  : ${ctx.percentileQty}e percentile | Poids QTÉ réseau fournisseur : ${ctx.weightQtyFournisseur}% | Poids QTÉ réseau rayon N2 : ${ctx.weightQtyRayon}%`);
        lines.push(`• Marge        : ${ctx.percentileMarge}e percentile`);
        lines.push(`• Score composite : ${ctx.percentileComposite}/100`);
        lines.push("");

        // Signaux — tous présentés factuellement, sans recommandation inline
        lines.push(`--- SIGNAUX ---`);

        // Signal rouge prioritaire
        if (ctx.isDeadStock) {
            lines.push(`[⛔ STOCK MORT] Statistiques absolues dérisoires (CA < 100€ ou QTÉ < 20 unités sur le réseau) → non rentable pour notre modèle volume`);
        }
        if (ctx.isLowContribution) {
            lines.push(`[⛔ CONTRIBUTION FAIBLE] Percentiles CA (${ctx.percentileCa}) et QTÉ (${ctx.percentileQty}) dans les 30% inférieurs → produit marginal`);
        }
        if (ctx.scoreCritique) {
            lines.push(`[⛔ SCORE CRITIQUE] Score brut < 20 → sous-seuil absolu`);
        }

        // Signaux positifs
        if (ctx.isLocomotiveRayon) {
            lines.push(`[🚂 LOCOMOTIVE RAYON] Poids CA rayon: ${ctx.weightCaRayon}% | Poids QTÉ rayon: ${ctx.weightQtyRayon}% → Pilier structurant de la nomenclature`);
        }
        lines.push(`${ctx.isTop20Ca ? "[✓]" : "[ ]"} Top 20% CA/magasin fournisseur`);
        lines.push(`${ctx.isTop20Qty ? "[✓]" : "[ ]"} Top 20% Quantités/magasin fournisseur`);
        lines.push(`${ctx.isHighVolumeWithLowMargin ? "[✓]" : "[ ]"} Fort volume/magasin (>P60 lot) avec marge faible`);
        lines.push(`${ctx.isMargePure ? "[✓]" : "[ ]"} Forte marge (>P70 lot) malgré volume/magasin faible`);
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
