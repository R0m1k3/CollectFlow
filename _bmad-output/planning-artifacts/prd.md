---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish']
inputDocuments: []
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 0
  projectDocs: 0
workflowType: 'prd'
classification:
  projectType: Web Application
  domain: Retail Analytics
  complexity: Medium
  projectContext: greenfield
---

# Product Requirements Document - CollectFlow

**Author:** Michael  
**Date:** 2026-02-23  

## Executive Summary

L'application **CollectFlow** est conçue pour optimiser l'assortiment des magasins de détail en identifiant et en gérant l'élite des produits (les meilleures ventes en volume, CA et marge), tout en préservant stratégiquement les produits de complément indispensables. L'objectif est de maximiser la profitabilité de la surface de vente allouée.

Destinée aux acheteurs et directeurs de magasin, CollectFlow transforme des statistiques croisées complexes issues d'une base PostgreSQL en actions de gestion simples et immédiates. En analysant les données de vente globalement sur le parc (2 magasins), l'application permet des décisions d'achat et un merchandising basés sur la performance réelle, tout en garantissant un "Zero-Learning UX" pour des utilisateurs épisodiques.

## Innovation & Novel Patterns

CollectFlow se distingue par son approche **Ergonomie Décisionnelle** (Tactical Speed & Zero-Learning UX). Plutôt que de proposer un outil d'analyse complexe, l'application condense l'intelligence (croisement multidimensionnel) dans une vue tabulaire actionnable immédiatement.

- **Simplicité Tactique :** Une interface utilisateur qui masque les calculs complexes derrière une mécanique évidente (modification directe via menu déroulant, validation en un clic).
- **Paramétrage Adaptatif :** La capacité des gammes (A, B, C) n'est pas fixe ; l'utilisateur définit le volume de références cibles par fournisseur et par magasin.
- **Cycle de Vie (Gamme Z) :** Les produits non performants sont classés en "Gamme Z" (abandon) pour conserver l'historique d'analyse et éviter de reproduire de mauvais choix futurs.
- **Export Différentiel :** Génération native d'un Excel "Delta" pour la réintégration fluide des décisions dans le logiciel de gestion existant.

## Success Criteria

### Measurable Outcomes

- **Efficacité Opérationnelle :** Réduction drastique du temps passé par un acheteur pour réviser et valider l'assortiment d'un fournisseur (objectif < 15 min par collection).
- **Impact Business :** Hausse mesurable du CA et de la Marge sur les rayons optimisés après 3 à 6 mois d'utilisation.
- **Adoption :** Capacité d'un utilisateur à utiliser l'outil sans formation préalable, même après 6 mois d'inactivité.

### Technical Success

- **Performance :** Vues de données fluides basées sur des pré-calculs PostgreSQL (MatViews).
- **Intégration :** Export Excel 100% compatible avec les structures syntaxiques du logiciel cible.

## User Journeys

### L'Acheteur : Revue Stratégique (2 à 3 fois par an)

L'Acheteur gère l'assortiment pour les deux magasins. Son utilisation est épisodique, liée au rythme des collections.

1. **Accueil (Cold Start) :** Connexion et sélection immédiate du périmètre (Magasins 1, 2 ou Global) et du Fournisseur.
2. **Arbitrage (Tableau de Bord) :** Consultation d'une grille dense mais claire affichant les KPI (Ventes/mois, CA, Marge) et un scoring visuel automatique ("Fort Volume / Faible Marge", etc.).
3. **Ajustement (Intervention Humaine) :** L'Acheteur compare l'ancienne gamme à la proposition de l'IA. Il peut surcharger manuellement (override) ou appliquer des modifications en masse (Bulk).
4. **Clôture (Export) :** Génération de l'export Excel contenant uniquement le "Delta" pour réimportation dans l'outil de gestion tiers.

## Project Scoping & Phases

### Phase 1 - MVP (Focus Résolution)

- **Cœur :** Filtrage Magasin/Fournisseur et vue tabulaire haute performance.
- **Capabilities :** Édition inline, scoring basique (Volume/Marge), gestion de session via Snapshots.
- **Sortie :** Export Excel Delta formaté pour le logiciel cible.

### Phase 2 - Growth (Optimisation)

- Historisation sur 12 mois glissants et comparaison N-1.
- Actions en masse (Bulk Actions) avancées par catégories de produits.
- Intelligence analytique poussée (Analyse de l'effet de Halo).

### Phase 3 - Vision (Automatisation)

- Synchronisation bidirectionnelle directe via API, éliminant l'export Excel.

## Functional Requirements (Capability Contract)

### 1. Périmètre & Sélection

- **FR1 :** Sélection du périmètre d'analyse (Magasin 1, 2, ou Global).
- **FR2 :** Sélection du fournisseur cible.

### 2. Grille de Performance

- **FR3 :** Consultation de la liste complète des produits actifs (via PostgreSQL).
- **FR4 :** Visualisation des KPI mensuels (Ventes, CA, Marge) sur l'historique disponible.
- **FR5 :** Affichage d'un scoring visuel de performance (Forces/Faiblesses).

### 3. Arbitrage Assisté par IA/Algorithme

- **FR6 :** Définition de la capacité cible (quotas) par gamme (A, B, C) par magasin.
- **FR7 :** Déclenchement manuel de l'analyse IA (via OpenRouter).
- **FR8 :** Visualisation comparative "Ancienne Gamme" vs "Suggestion IA".
- **FR9 :** Surcharge manuelle individuelle (inline) ou en masse (Bulk) des gammes.
- **FR10 :** Alerte visuelle en cas de dépassement des quotas de capacité définis.

### 4. Gestion de Session & Snapshots

- **FR11 :** Enregistrement de l'état du travail via des 'Snapshots' horodatés et nommés.
- **FR12 :** Comparaison de snapshots pour visualiser l'évolution des décisions.
- **FR13 :** Annulation des modifications non sauvegardées pour revenir au dernier état validé.

### 5. Export & Intégration

- **FR14 :** Prévisualisation du résumé des changements (Delta) avant confirmation.
- **FR15 :** Génération d'un export Excel 'Delta' strictement formaté pour le système cible.

## Non-Functional Requirements

### Performance & UX

- **Fluidité Grille :** Réponse au défilement et filtrage < 100ms.
- **Réactivité Bulk :** Application des changements en masse < 200ms côté client.
- **Vitesse IA :** Retour des propositions IA en moins de 10 secondes.

### Intégration & Sortie

- **Fiabilité Export :** Traitement sans échec jusqu'à 10 000 lignes de produits.
- **Intégrité :** Respect strict des types de données (GTIN/Codein) pour l'interopérabilité.

### Sécurité & Infrastructure

- **Rôles :** Distinction entre 'Admin' (gestion quotas/nomenclatures) et 'Acheteur' (arbitrage).
- **Secret Management :** Clés API et Database URL conservées exclusivement côté serveur.
- **Déploiement :** Environnement conteneurisé Docker et optimisation pour Google Chrome.
