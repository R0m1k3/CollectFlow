---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type']
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
**Date:** 2026-02-20

## Executive Summary

L'application **CollectFlow** est conçue pour optimiser l'assortiment des magasins de détail en identifiant et en gérant l'élite des produits (les meilleures ventes en volume, chiffre d'affaires et marge), tout en préservant stratégiquement les produits de complément indispensables grâce à l'analyse de l'effet de halo. L'objectif profond est de maximiser la profitabilité de la surface de vente allouée. Elle s'adresse aux acheteurs et directeurs de magasin en transformant des statistiques croisées complexes issues d'une base SQL en actions de gestion de collection simples et immédiates. En analysant les données de vente de manière globale sur l'ensemble du parc (2 magasins), l'application permet des décisions d'achat et un merchandising basés sur la performance réelle.

### What Makes This Special

CollectFlow se distingue par son approche paramétrique adaptative couplée à une interface d'une extrême simplicité tactique.

- **Simplicité Tactique :** Une interface utilisateur qui masque les calculs complexes (vues matérialisées nocturnes) derrière une mécanique évidente (modification directe de la gamme dans la ligne du tableau, validation en un clic) pour construire les gammes.
- **Paramétrage Dynamique par Fournisseur :** Contrairement aux systèmes rigides, la capacité des gammes (A, B, C) n'est pas fixe. L'utilisateur définit le volume de références cibles par fournisseur et par magasin (ex: 400 références pour la Gamme A chez le Fournisseur X).
- **Intelligence du Cycle de Vie (Gamme Z) :** Au lieu de simplement supprimer les produits non performants, l'application les classe en "Gamme Z" (abandon). Cela permet de conserver l'historique d'analyse pour éviter de reproduire de mauvais choix d'achat futurs, tout en nettoyant les vues actives. Le système inclut un export natif au format Excel pour les gammes cibles, permettant la réintégration fluide et immédiate des décisions d'assortiment dans le logiciel de gestion de magasin existant.

## Project Classification

- **Project Type:** Web Application
- **Domain:** Retail Analytics & Inventory Management
- **Complexity:** Medium (Nécessite des agrégations de données poussées, vues matérialisées PostgreSQL, architecture multi-magasins/multi-fournisseurs)
- **Project Context:** Greenfield (Nouveau projet)

## Success Criteria

### User Success

- L'utilisateur visualise instantanément les performances clés (Quantité vendue, CA, Marge par mois) d'un produit via un tableau de bord clair et épuré.
- L'utilisateur gagne un temps significatif grâce à l'assistance d'un tri IA/Algorithmique suggérant les meilleures affectations de gammes selon la capacité définie.
- L'utilisateur surcharge manuellement les gammes de manière fluide (menu déroulant directement dans la ligne du tableau) pour maintenir les produits de complément essentiels.

### Business Success

- Croissance mesurable du Chiffre d'Affaires (CA) global et de la rentabilité (Marge) par fournisseur sur les collections optimisées.
- Le cycle de vie complet du produit est respecté : les produits obsolètes ou non performants sont sortis des vues actives via la Gamme Z, permettant des achats futurs plus pertinents.

### Technical Success

- Les vues de données (basées sur PostgreSQL) s'affichent rapidement, rendues possibles par des vues matérialisées ou des pré-calculs.
- L'export Excel généré s'intègre parfaitement, sans manipulation manuelle supplémentaire, dans le logiciel de gestion de magasin existant.

### Measurable Outcomes

- Le temps passé par un acteur de l'achat/magasin pour réviser et valider l'assortiment d'un fournisseur est drastiquement réduit.
- Hausse du CA et de la Marge sur les rayons optimisés après 3 à 6 mois d'utilisation.

## Product Scope

### MVP - Minimum Viable Product

- **Périmètre & Filtres :** Sélection du magasin (Magasin 1, Magasin 2, ou Global) et du fournisseur.
- **Tableau de Bord de Performance :** Vue tabulaire métier (libellé, nomenclature) détaillant pour chaque article sa gamme modifiable en ligne, les ventes/mois (6 mois initiaux, évolutif vers 12 mois + comparaison N-1 Global), le CA, et la marge.
- **Gestion Tactique des Gammes :** Allouer les produits dans les gammes A, B, C ou Z (abandon) selon une capacité cible par fournisseur, avec pré-tri algorithmique et forçage manuel (produits de complément).
- **Export Intelligent :** Exportation Excel *uniquement* des produits dont la gamme a été modifiée (y compris les passages en Gamme Z), formaté strictement selon le squelette du logiciel de gestion cible.

### Growth Features (Post-MVP)

- Historisation sur 12 mois glissants et comparaison avec l'année précédente (N-1) au fur et à mesure de l'enrichissement de la base SQL.
- Analyse prédictive / mesure chiffrée de "l'effet de halo" rattaché aux produits de complément.

### Vision (Future)

- Synchronisation via API (bidirectionnelle) directe avec le logiciel de gestion du magasin, éliminant l'étape d'export/import Excel.

## User Journeys

### L'Acheteur : La Revue Stratégique de Collection (2 à 3 fois par an)

**Profil :** L'Acheteur (ou Responsable Réseau) gère l'assortiment pour les deux magasins. Son utilisation de l'outil est épisodique correspondant aux rythmes des collections fournisseurs.
**Objectif :** Libérer de la place pour la nouvelle collection d'un fournisseur, tout en conservant les références clés (volume, marge) et les produits de réassurance.

**Le Parcours :**

1. **L'Accueil (Cold Start) :**
   L'acheteur se connecte. Puisqu'il ne s'est pas connecté depuis la dernière collection (environ 6 mois), l'application affiche un premier écran lui demandant de choisir son périmètre (Magasins 1, 2 ou Global) et le Fournisseur.

2. **La Vue Comparative & Notation (Le Tableau de Bord) :**
   L'application affiche une grille dense mais claire par produit :
   - Un **système de score** visuel indique immédiatement la nature du produit (Ex: "Fort Volume / Faible Marge" ou "Faible Volume / Forte Marge").
   - L'historique des ventes est visible (actuellement 6 mois, extensible à 1-2 ans pour voir l'évolution).
   - Une vue en "split-screen" (côte-à-côte) montre : *Ancienne Gamme (Actuelle)* vs *Nouvelle Gamme Proposée par l'IA*.

3. **L'Ajustement Tactique (L'Intervention Humaine) :**
   L'IA a proposé de passer 50 produits en Gamme Z (abandon) car leurs notes (Score Volume + Score Marge) sont trop faibles.
   L'acheteur, sachant qu'une référence spécifique est cruciale pour l'image de marque du magasin, effectue une *surcharge manuelle* (override) via un menu déroulant directement dans la ligne pour forcer ce produit en Gamme B ou C. S'il doit manipuler plusieurs produits, il utilise une sélection par lot (Bulk Action) pour attribuer une gamme en masse.

4. **La Clôture & L'Export Différentiel :**
   Une fois la nouvelle gamme validée, l'acheteur génère l'export Excel. La valeur métier forte intervient ici : l'application n'exporte *que le delta* (les produits dont la gamme a changé par rapport à la session précédente), incluant les mises au rebut (Gamme Z).
   Il importe ce fichier dans le logiciel de gestion de magasin existant et déconnecte de CollectFlow jusqu'à la prochaine saison.

### Journey Requirements Summary

Ce parcours révèle les besoins techniques et UX suivants :

- **UX "Zero-Learning" / Cold Start :** L'interface doit être immédiatement compréhensible après des mois d'inactivité.
- **Scoring Multidimensionnel :** Un algorithme capable de noter et de typer un produit (Volume vs Marge vs CA) pour guider le tri.
- **Grille Comparative Avancée :** Affichage "État Actuel" vs "État Futur Proposé" pour chaque ligne.
- **Surcharge Manuelle & Actions par Lot :** Capacité à contredire l'IA à l'unité ou en masse (Bulk).
- **Moteur d'Export Différentiel (Snapshot) :** La base de données doit enregistrer des "Snapshots" (photographies d'état) à chaque session validée pour calculer le delta exact des changements de gammes lors de l'export Excel.

## Innovation & Novel Patterns

### Detected Innovation Areas

L'innovation principale de CollectFlow réside dans son **Ergonomie Décisionnelle** (Tactical Speed & Zero-Learning UX). Plutôt que de proposer un outil d'analyse complexe nécessitant une formation approfondie (comme c'est la norme pour les logiciels de Retail Analytics), l'application condense l'intelligence (croisement volume/marge/CA sur 2 magasins) dans une vue tabulaire actionnable immédiatement. L'édition en ligne via menu déroulant permet de valider des décisions stratégiques en quelques minutes, même pour un utilisateur dont la dernière connexion remonte à 6 mois.

### Market Context & Competitive Landscape

Les solutions existantes sur le marché imposent souvent à l'acheteur de manipuler des rapports lourds ou de maîtriser des interfaces d'analyse multidimensionnelles. En se focalisant sur le "Job to be Done" (réviser une collection fournisseur 2 à 3 fois par an), CollectFlow élimine le bruit visuel et accélère drastiquement la prise de décision.

### Validation Approach

Pour valider cette approche, il faudra tester l'interface avec l'acheteur représentant la cible, sans formation préalable. Le succès sera prouvé s'il parvient à identifier les anomalies, modifier les gammes de manière fluide, et générer son export en un temps record (ex: moins de 15 minutes pour un fournisseur) dès la première session.

### Risk Mitigation

Le risque principal d'une vue tabulaire métier est la surcharge visuelle (le syndrome de "l'usine à gaz") au fur et à mesure de l'ajout de nouvelles données (N-1, indicateurs supplémentaires).
*Mitigation :* Maintenir une discipline de conception stricte (Progressive Disclosure). Les informations secondaires doivent n'être révélées qu'à la demande (ex: clic sur une ligne pour voir le détail des 12 mois) afin de conserver un tableau principal ultra-épuré et dédié à l'action.

## Web Application Specific Requirements

### Project-Type Overview

CollectFlow est conçue comme une **Single Page Application (SPA)** interne. Ce format garantit une expérience analytique fluide et sans rechargement pour l'Acheteur.

### Technical Architecture Considerations

- **Single Page Application (SPA) :** L'architecture front-end doit permettre la manipulation immédiate (tris, actions par lot, modifications de gammes en ligne) d'un large volume de données sans latence ni rafraîchissement global de l'écran.
- **Cible Navigateur :** Le développement et le support sont optimisés exclusivement pour **Google Chrome (Desktop)**, reflétant les standards des postes de travail des équipes d'achat.
- **Data en Temps Réel :** Contrairement aux systèmes de batching nocturnes locaux, l'application doit s'appuyer sur des bases de données de caisse "en live" ou synchronisées en temps réel pour afficher l'état instantané des encaissements lorsqu'une collection est révisée.
- **Stratégie SEO & Accessibilité :** S'agissant d'un outil fermé B2B, le référencement (SEO) est inactif. L'interface (UI/UX) doit toutefois obéir à des règles de fort contraste pour éviter la fatigue visuelle face à la densité des tableaux de bord (Accessibilité Cognitive).
