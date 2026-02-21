---
stepsCompleted: [step-01-validate-prerequisites]
inputDocuments: [
  'c:\Users\Michael\Git\CollectFlow\_bmad-output\planning-artifacts\prd.md',
  'c:\Users\Michael\Git\CollectFlow\_bmad-output\planning-artifacts\ux-design-specification.md'
]
---

# CollectFlow - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for CollectFlow, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: L'Acheteur peut sélectionner le périmètre d'analyse (Magasin 1, Magasin 2, ou Global).
FR2: L'Acheteur peut sélectionner le fournisseur à analyser.
FR3: L'Acheteur peut consulter la liste complète des produits actifs pour le périmètre et fournisseur sélectionnés, issue de la base PostgreSQL.
FR4: L'Acheteur peut visualiser la quantité vendue, le Chiffre d'Affaires et la marge générée par mois (jusqu'à 6 mois d'historique) pour chaque produit.
FR5: L'Acheteur peut identifier visuellement un premier score de performance "Basique" (Volume vs Marge) pré-calculé sans IA.
FR6: L'Acheteur peut définir la capacité cible (nombre d'articles) pour chaque gamme (A, B, C) par fournisseur et magasin.
FR7: L'Acheteur peut déclencher manuellement une analyse IA via un bouton d'action dédié.
FR8: L'Application soumet les KPIs (Quantité, CA, Marge) au modèle IA (via OpenRouter) suite à ce déclenchement, et affiche la proposition de gamme (A, B, C, Z) pour chaque produit.
FR9: L'Acheteur peut visualiser de façon comparative la gamme actuelle et la proposition algorithmique/IA pour chaque produit.
FR10: L'Acheteur peut attribuer manuellement de façon individuelle (surcharge) la gamme finale d'un produit (A, B, C, Z).
FR11: L'Acheteur peut attribuer une gamme spécifique en masse (Bulk Action) à une sélection de produits.
FR12: L'Acheteur peut annuler les modifications non sauvegardées de sa session en cours et revenir au dernier état validé.
FR13: L'Acheteur peut prévisualiser un résumé global des changements de gammes (le delta) avant de confirmer.
FR14: L'Acheteur peut enregistrer et valider définitivement les choix de gammes effectués. (Création d'un Snapshot persistant en base).
FR15: L'Acheteur peut générer un fichier d'export au format Excel des données validées. Ce fichier contient uniquement le delta par rapport à la session précédente.
FR16: Le système formate techniquement l'export Excel selon la structure syntaxique attendue par le logiciel de gestion de magasin cible.
FR17: L'Application peut être déployée et exécutée dans un environnement Docker.
FR18: L'Administrateur peut configurer les paramètres de connexion à la base de données PostgreSQL via des variables d'environnement.
FR19: L'Administrateur peut configurer la connexion à l'IA (Clé API OpenRouter, Modèle) via des variables d'environnement.
FR20: L'Utilisateur peut s'authentifier de manière sécurisée (connexion B2B).

### NonFunctional Requirements

NFR-PERF-1: Le tableau de bord initial (liste des produits) s'affiche en moins de 3s pour 10 000 lignes.
NFR-PERF-2: Les modifications de gamme "en ligne" sont répercutées visuellement en moins de 100ms.
NFR-PERF-3: Les réponses de l'IA (OpenRouter) s'affichent en moins de 10s.
NFR-SEC-1: Authentification avec mots de passe forts (min 12 car., complexité).
NFR-SEC-2: Clés API et identifiants DB jamais exposés côté client (Backend uniquement via env vars).
NFR-SEC-3: Trafic HTTPS/TLS 1.2 minimum.
NFR-INT-1: Export Excel strictement conforme à l'encodage et au nommage du logiciel cible.
NFR-REL-1: Système de Snapshot garantissant la non-altération des états historiques si crash.

### Additional Requirements (from UX Specification)

- **Layout 32" Fluide** : Le design s'adapte à 100% de la largeur des écrans larges (XL > 1440px).
- **Grille "Ultra-Dense"** : Nomenclature, Historique M1-M12, Total Qté 12m, et Marge (€/%) visibles sur une seule ligne.
- **Heatmap Intelligence** : Coloration conditionnelle des cellules de vente (M1-M12) et badge couleur pour la marge.
- **Auto-Jump Logic** : Passage automatique à la référence suivante après un arbitrage manuel.
- **Sticky Headers** : Colonnes d'en-tête et résumé financier (Summary Bar) fixes au scroll.
- **Tabular Numbers** : Utilisation de polices à espacement fixe (`JetBrains Mono`) pour l'alignement décimal des données financières.
- **Zero-Learning UX** : Interface tabulaire épurée sans pop-ups intrusifs, édition "Inline" privilégiée.

### FR Coverage Map

- **FR1 (Sélection Périmètre)**: Epic 2
- **FR2 (Sélection Fournisseur)**: Epic 2
- **FR3 (Liste Produits)**: Epic 2
- **FR4 (KPIs Mensuels)**: Epic 2
- **FR5 (Pre-score Basique)**: Epic 2
- **FR6 (Capacité Cible)**: Epic 3
- **FR7 (Déclenchement IA)**: Epic 4
- **FR8 (Analyse IA)**: Epic 4
- **FR9 (Vue Comparative)**: Epic 4
- **FR10 (Surcharge Individuelle)**: Epic 3
- **FR11 (Actions Bulk)**: Epic 3
- **FR12 (Annulation)**: Epic 3
- **FR13 (Prévisualisation Delta)**: Epic 3
- **FR14 (Snapshot & Validation)**: Epic 5
- **FR15 (Génération Export)**: Epic 5
- **FR16 (Formatage ERP)**: Epic 5
- **FR17 (Dockerization)**: Epic 1
- **FR18 (Config PostgreSQL)**: Epic 1
- **FR19 (Config AI/OpenRouter)**: Epic 1
- **FR20 (Authentification B2B)**: Epic 1

**NFR Mapping:**
- **Performance (Grid)**: Epic 2
- **Réactivité (Inline)**: Epic 3
- **Sécurité & API**: Epic 1
- **Fidélité Export**: Epic 5
- **Fiabilité (Snapshot)**: Epic 5

## Epic List

## Epic 1: Fondations & Connectivité

Mise en place de l'environnement technique, de la base de données et de l'accès sécurisé pour permettre le démarrage du projet.

### Story 1.1: Environnement Docker & Orchestration

As an Administrator,
I want to manage the application architecture within Docker containers,
So that I can ensure a reproducible and isolated environment for development and production.

**Acceptance Criteria:**

**Given** a project directory with a Docker configuration
**When** I run `docker-compose up`
**Then** three containers (Frontend, Backend, PostgreSQL) start successfully
**And** they can communicate internally through a dedicated Docker network.

### Story 1.2: Configuration Base de Données & Environnement

As a Developer,
I want to connect the application to a PostgreSQL database using environment variables,
So that I can secure credentials and separate configuration from code.

**Acceptance Criteria:**

**Given** the database container is running
**When** the backend initializes with the provided DB_URL variable
**Then** it successfully retrieves data from the 'configuration' table
**And** the initial schema from `docs/database-schema.sql` is applied.

### Story 1.3: Authentification B2B Sécurisée

As an Buyer,
I want to log in to the application with my credentials,
So that my professional data and decision-making environment are secured.

**Acceptance Criteria:**

**Given** the application is running on its domain
**When** I enter a valid email and a strong password (>12 characters)
**Then** I am redirected to the Dashboard
**And** session tokens are managed securely according to NFR-SEC-1.

### Story 1.4: Services IA (OpenRouter)

As a Developer,
I want a dedicated backend service to communicate with the OpenRouter API,
So that AI requests are centralized and the API key is never exposed to the client.

**Acceptance Criteria:**

**Given** the OpenRouter API key is set in environment variables
**When** the backend service sends a test prompt to a specified model
**Then** it receives a valid JSON response from the AI
**And** no API tokens are leaked in the client-side SPA bundle (NFR-SEC-2).

## Epic 2: Exploration de Performance (Vue Grid)

Permettre à l'acheteur de sélectionner un périmètre et de visualiser les performances réelles (ventes, CA, marge) via la grille ultra-dense.

### Story 2.1: Sélecteur de Contexte (Magasin/Fournisseur)

As a Buyer,
I want to select a specific store and provider from a sidebar,
So that I can focus my analysis on a precise subset of my collection.

**Acceptance Criteria:**

**Given** the application is loaded
**When** I select "Magasin 1" and provider "Fournisseur X" in the sidebar
**Then** the dashboard triggers a data fetch for this specific context
**And** the UI displays the currently active filters clearly.

### Story 2.2: Grille de Performance Ultra-Dense (Fondation)

As a Buyer,
I want to scroll through thousands of product lines without lag on my 32" screen,
So that I can maintain a high-speed professional workflow.

**Acceptance Criteria:**

**Given** a dataset of 10,000 product references
**When** I scroll the main data grid
**Then** the rendering remains fluid (using virtualization)
**And** the column headers remain fixed to the top (Sticky Headers).

### Story 2.3: Historique de Ventes & Heatmap 12m

As a Buyer,
I want to see a 12-month rolling sales history visualized as a heatmap,
So that I can immediately identify seasonality or recent stockouts.

**Acceptance Criteria:**

**Given** historical sales data in the database
**When** the grid renders a product line
**Then** it displays 12 columns with Month/Year labels (e.g., "Jan 25")
**And** the background color of each cell varies from gray (0) to deep blue based on quantity sold.

### Story 2.4: Cellules Financières & Pre-scoring (Marge & CA)

As a Buyer,
I want to see precise financial KPIs (Turnover, Margin) in a highly readable format,
So that I can make arbitrage decisions based on real profitability.

**Acceptance Criteria:**

**Given** calculated financial metrics
**When** the grid displays the Margin and Turnover columns
**Then** it uses `JetBrains Mono` for perfect vertical decimal alignment
**And** the margin percentage is highlighted (e.g., Emerald badge for >45%, Rose for <20%).

## Epic 3: Arbitrage Tactique & Supervision Humaine

Permettre à l'acheteur d'ajuster manuellement l'assortiment, d'utiliser le bulk-editing et de voir l'impact financier en temps réel.

### Story 3.1: Définition des Capacités Cibles

As a Buyer,
I want to set the target number of items for categories A, B, and C,
So that I can align my assortment decisions with my shelf capacity and budget.

**Acceptance Criteria:**

**Given** the provider analysis page is open
**When** I enter target quantities for Gamme A, B, and C in the configuration header
**Then** the values are saved for the current session
**And** the summary bar uses these targets to calculate the current "fill rate" (e.g., 80/100 items allocated).

### Story 3.2: Arbitrage "Inline" & Auto-Jump

As a Buyer,
I want to change a product's status (A, B, C, Z) directly in the table row and move to the next item automatically,
So that I can process hundreds of products at high speed without interruption.

**Acceptance Criteria:**

**Given** a list of products in the grid
**When** I select a new status (e.g., "Gamme Z") from the dropdown menu in a row
**Then** the status is updated instantly with a visual highlight
**And** the focus (or active row indicator) automatically moves to the next product line.

### Story 3.3: Barre de Résumé Flottante & Recalcul Temps Réel

As a Buyer,
I want to see the cumulative impact of my choices on Turnover and Margin updated in real-time,
So that I can ensure my final collection meets my financial performance goals.

**Acceptance Criteria:**

**Given** the floating summary bar is visible at the bottom of the screen
**When** I modify a product's category (A/B/C/Z)
**Then** the totals for Quantity, Turnover, and Margin in the bar update in less than 100ms
**And** the numbers pulse or animate slightly to acknowledge the change.

### Story 3.4: Actions en Masse (Bulk Actions) & Annulation

As a Buyer,
I want to apply a status to multiple selected products or reset all unconfirmed changes,
So that I can quickly handle large batches of items and recover from mistakes.

**Acceptance Criteria:**

**Given** multiple products are selected via checkboxes
**When** I choose "Assign to Gamme A" from the bulk action menu
**Then** all selected products are updated simultaneously
**And** clicking "Reset Session" reverts all products to their state at the start of the session.

## Epic 4: Assistance IA & Aide à la Décision

Déclencher l'intelligence algorithmique pour obtenir des recommandations de gammes basées sur OpenRouter.

### Story 4.1: Génération de Prompt & Envoi des KPIs

As a Buyer,
I want to trigger an AI analysis manually for a specific provider,
So that I can receive intelligent sorting suggestions based on the most recent sales performance data.

**Acceptance Criteria:**

**Given** the provider's grid is loaded with product KPIs
**When** I click the "Trigger AI Analysis" button
**Then** the system packages the Turnover, Margin, and Quantity data for all products in the filtered view
**And** sends this payload to the backend for prompt generation.

### Story 4.2: Traitement IA & Réception des Suggestions (OpenRouter)

As a Developer,
I want the system to parse and map the AI response from OpenRouter back to the product list,
So that recommandations are correctly associated with their respective references.

**Acceptance Criteria:**

**Given** the backend has received an AI response (JSON) from OpenRouter
**When** the response is returned to the frontend
**Then** each product ID is mapped to its proposed category (A, B, C, or Z)
**And** the entire process completes in less than 10 seconds (NFR-PERF-3).

### Story 4.3: Vue Comparative "Actuel vs IA"

As a Buyer,
I want to see the AI's proposed category right next to the current category,
So that I can immediately spot and audit the recommended changes.

**Acceptance Criteria:**

**Given** AI recommendations have been received
**When** the grid renders
**Then** a new column "Proposition IA" is displayed
**And** cells where the AI suggestion differs from the current status are visually highlighted.

### Story 4.4: Affichage des "AI Insights" (Commentaire Contextuel)

As a Buyer,
I want to read a short justification for each AI recommendation,
So that I can understand the context (e.g., stockouts, margin trends) before approving a category change.

**Acceptance Criteria:**

**Given** the AI has provided textual justifications (insights)
**When** I hover over an AI recommendation or view the product details
**Then** a compact text block is displayed explaining the reasoning (e.g., "High volume but declining margin, downgrade to B")
**And** the insight is clearly legible and contextually relevant.

## Epic 5: Clôture, Snapshots & Export

Sécuriser les décisions via des snapshots de session et générer l'export Excel différentiel pour l'ERP.

### Story 5.1: Résumé Final & Prévisualisation du Delta

As a Buyer,
I want to see a global summary of my assortment changes before finalizing the session,
So that I can verify the financial impact and the number of products categorised as 'Z' (Removed).

**Acceptance Criteria:**

**Given** I have completed my arbitrage for a provider
**When** I click "Finalize Session"
**Then** a summary screen appears showing the total count of items in categories A, B, C, and Z
**And** it highlights the total Turnover and Margin impact of the session's diff (delta).

### Story 5.2: Validation de Session & Snapshot Persistant

As a Developer,
I want the system to save the current state of the assortment as a permanent Snapshot in the database,
So that I can use it as a reference for calculating deltas in future sessions.

**Acceptance Criteria:**

**Given** the user confirms the final summary
**When** the "Save Assortment" action is triggered
**Then** a new record is created in the database with the current category status for all products
**And** the current session is marked as "Validated".

### Story 5.3: Génération de l'Export Excel Différentiel

As a Buyer,
I want to download an Excel file containing only the products whose category has changed compared to the previous season,
So that I can import it directly into my ERP without manual filtering.

**Acceptance Criteria:**

**Given** a validated session with recorded snapshots
**When** I click "Generate Export"
**Then** the system identifies lines where the current category differs from the last Snapshot
**And** it generates an Excel file only containing these specific rows.

### Story 5.4: Formatage ERP & Encodage (UTF-8)

As an Administrator,
I want the exported Excel file to strictly follow the ERP's required syntax and encoding,
So that it can be imported without syntax errors or data corruption.

**Acceptance Criteria:**

**Given** the differential data is ready for export
**When** the Excel file is generated
**Then** it uses UTF-8 encoding
**And** the column headers and data types match exactly the skeleton provided in the target ERP requirements (NFR-INT-1).
