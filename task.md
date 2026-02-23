# Tâches en cours : Optimisation de l'Analyse IA (Phase 2 - Contextualisation)

## Contexte

L'IA (Mary) donne des recommandations incohérentes (ex: [Z] pour un produit plus performant qu'un [A]) car elle manque de repères relatifs. Elle ne connaît pas le poids réel d'un produit dans le chiffre d'affaires total du fournisseur ou du rayon.

## Focus Actuel

**Recherche & Développement** : Mieux définir les critères de ranking pour Mary afin d'éliminer les faux négatifs (Score 70+ classé en Z).

## Master Plan

- [x] Correction graphique du modal (Slate-950/Apple)
- [x] Étape 20 : Intégration des poids (%) et contribution relative (Analyse de Cohérence)
- [x] Étape 21 : Sanctuarisation des produits stratégiques dans le prompt
- [x] Étape 22 : Test et validation des recommandations (Élimination des faux Z)
- [ ] Recherche de meilleures pratiques pour le ranking IA (Analyse ABC/XYZ enrichie)
- [ ] Implémentation du calcul des poids (%) dans `score-engine.ts`
- [ ] Mise à jour des types `ProductAnalysisInput`
- [ ] Enrichissement du prompt Mary avec les notions de contribution (%)
- [ ] Test et validation sur les cas limites (Score 70+ classé en Z par erreur)

## Progress Log

- **Phase 1 terminée** : Modal UI polie et Portail React opérationnel.
- **Phase 1.5 terminée** : Mary prend désormais en compte le volume moyen du rayon et le PMV.
- **Découverte** : Mary a besoin du "Poids CA" et du "Total Fournisseur" pour donner un avis juste. Un CA de 552€ est faible pour un géant, mais vital pour un petit artisan.
