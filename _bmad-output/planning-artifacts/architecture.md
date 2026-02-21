---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
workflowType: 'architecture'
lastStep: 8
status: 'complete'
completedAt: '2026-02-21'
inputDocuments: [
  'c:\Users\Michael\Git\CollectFlow\_bmad-output\planning-artifacts\prd.md',
  'c:\Users\Michael\Git\CollectFlow\_bmad-output\planning-artifacts\ux-design-specification.md'
]
project_name: 'CollectFlow'
user_name: 'Michael'
---

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
L'architecture doit supporter un workflow de décision tactique en 2 magasins (plus vue globale). Les piliers fonctionnels sont :
- **Sélection de périmètre** (Magasin/Fournisseur) pilotant le chargement des données.
- **Grille de données Ultra-Dense** (10 000+ lignes) avec historique 12 mois (Heatmap).
- **Moteur d'arbitrage en ligne** (A/B/C/Z) avec recalcul immédiat des KPIs financiers (CA, Marge).
- **Intégration OpenRouter** pour les préconisations IA et justifications textuelles.
- **Persistance par Snapshots** pour permettre un export Excel différentiel (Delta).

**Non-Functional Requirements:**
- **Performance** : Rendu fluide de la grille (virtualisation) et latence < 100ms pour les interactions métier.
- **Sécurité** : Proxy API pour OpenRouter et isolation des clés côté serveur uniquement.
- **Fiabilité** : Snapshots de session persistants pour éviter les pertes de données lors des sessions d'arbitrage massives.

**Scale & Complexity:**
- **Primary domain**: Retail Analytics & Decision Support (B2B).
- **Complexity level**: Medium-High (Volume de données tabulaires + Intégration IA + Logique de Snapshot).
- **Estimated architectural components**: Frontend Grid Service, Backend AI Proxy, Database Snapshot Manager, Excel Export Engine.

### Technical Constraints & Dependencies
- **Data Layer** : Base de données PostgreSQL avec un schéma existant (`ventes_produits`, vues matérialisées).
- **Frontend Constraints** : Besoin critique de virtualisation pour gérer la densité sans perte de frames.
- **Deployment** : Environnement Docker-orchestrated.

### Cross-Cutting Concerns Identified
- **State Management** : Gestion de l'état "Draft" (arbitrages non validés) vs État permanent.
- **Performance Monitoring** : Temps de réponse des appels IA et génération d'export.
- **Data Visualization** : Rendu performant de la Heatmap 12m par ligne.

## Starter Template Evaluation

### Primary Technology Domain
Dashboard Décisionnel Haute Performance (B2B SaaS / Retail Analytics) basé sur React.

### Selected Starter: Next.js (latest)
**Rationale for Selection:**
- **Proxy API Intégré** : Facilite la sécurisation des clés OpenRouter sans infrastructure backend séparée.
- **Server-Side logic** : Possibilité de déporter le calcul massif des KPIs et la gestion des Snapshots côté serveur.
- **Ecosystème Shadcn/Radix** : Intégration native parfaite avec la stack visuelle cible.

**Initialization Command:**
```bash
npx create-next-app@latest ./ --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --turbo
```

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Choix de Next.js comme socle full-stack.
- Utilisation de Drizzle ORM pour l'accès aux données PostgreSQL.
- Implémentation de TanStack Table v8 avec virtualisation pour la grille 10 000 lignes.

**Important Decisions (Shape Architecture):**
- Adoption de Zustand pour la gestion d'état "Draft" (sessions d'arbitrage).
- Utilisation de Next.js Server Actions pour une communication API type-safe.
- Sécurisation via Auth.js (NextAuth) v5.

**Deferred Decisions (Post-MVP):**
- Cache global (Redis) : À évaluer si les performances de PostgreSQL/Drizzle ne suffisent pas après l'ajout de 50 000+ lignes.

### Data Architecture
- **ORM** : Drizzle ORM (v0.45.1). Rationale : Performance brute et overhead minimal.
- **Validation** : Zod (v3.x). Rationale : Typage de bout en bout.
- **Persistence Strategy** : Snapshotting des états par session Fournisseur pour calcul de différentiel.

### Authentication & Security
- **Auth Solution** : Auth.js v5 (NextAuth). Pattern de session sécurisée.
- **Security Constraints** : API Proxy Backend obligatoire pour OpenRouter (NFR-SEC-2).

### API & Communication Patterns
- **Standard interactions** : Next.js Server Actions (Typage Fort avec Zod).
- **Heavy lifting** : Route Handlers (`/api/ai/analyze`, `/api/export/excel`) pour les traitements longs.

### Frontend Architecture
- **Grid Engine** : TanStack Table v8 + `@tanstack/react-virtual`.
- **State Store** : Zustand. Pattern : Store atomique par domaine (Grid, Context, Summary).
- **Data Fetching** : TanStack Query v5.

## Implementation Patterns & Consistency Rules

### Naming Patterns
- **Database** : `snake_case`.
- **Code/API** : `camelCase` (Drizzle s'occupe du mapping).
- **Components** : `PascalCase.tsx` (ex: `HeatmapGrid.tsx`).
- **Hooks/Utils** : `kebab-case.ts` (ex: `use-arbitrage-logic.ts`).

### Structure & Process
- **Architecture** : Feature-Driven in `src/features/`.
- **State** : Store atomique par feature via Zustand.
- **API** : Server Actions avec retour `{ success, data, error }`.
- **Tests** : Co-located `[Name].test.tsx`.

## Project Structure & Boundaries

### Complete Project Directory Structure
```text
CollectFlow/
├── public/                 # Assets statiques (Logos, Icons)
├── src/
│   ├── app/                # Next.js App Router (Routes & Layouts)
│   │   ├── (auth)/         # Routes d'authentification (Epic 1)
│   │   ├── (dashboard)/    # Cœur de l'application (Epic 2 & 3)
│   │   │   └── grid/       # Page principale de la grille
│   │   └── api/            # Route Handlers (IA Proxy, Export Excel)
│   ├── components/
│   │   ├── ui/             # Composants Shadcn (Boutons, Inputs, Toast)
│   │   └── shared/         # Composants transverses (Layout, Sidebar)
│   ├── features/           # Logique Métier par Domaine (Isolation Agents)
│   │   ├── grid/           # [Epic 2 & 3] Composants Heatmap, Store Zustand
│   │   ├── ai-copilot/     # [Epic 4] Intégration OpenRouter, Insights UI
│   │   ├── snapshots/      # [Epic 5] Logique de persistence et Delta
│   │   └── export/         # [Epic 5] Générateur Excel Différentiel
│   ├── db/                 # Configuration Drizzle, Schéma, Migrations
│   ├── lib/                # Clients partagés (Auth.js, OpenRouter, Utils)
│   └── types/              # Definitions TypeScript globales
├── .env.local              # Secrets (DB_URL, OPENROUTER_KEY)
├── package.json
└── tailwind.config.ts
```

### Architectural Boundaries

**API Boundaries:**
- Les **Server Actions** gèrent 90% des mutations métier.
- Les **Route Handlers** sont réservés aux flux externes (IA) et formats binaires (Excel).

**Data Boundaries:**
- Drizzle ORM possède la source de vérité du schéma (`src/db/schema.ts`).
- Les données "Draft" vivent exclusivement dans les stores **Zustand** avant validation.

### Requirements to Structure Mapping

**Epic/Feature Mapping:**
- **Epic 1 (Fondations)** : `src/db/`, `src/app/(auth)/`, `src/lib/auth.ts`.
- **Epic 2 (Vue Grid)** : `src/features/grid/components/`, `src/features/grid/store/`.
- **Epic 3 (Arbitrage)** : `src/features/grid/hooks/use-arbitrage.ts`.
- **Epic 4 (IA)** : `src/features/ai-copilot/`, `src/app/api/ai/`.
- **Epic 5 (Snapshots & Export)** : `src/features/snapshots/`, `src/features/export/`.

**Cross-Cutting Concerns:**
- **Authentication** : Protect via `src/middleware.ts` and `src/lib/auth.ts`.
- **Visual Theme** : Centralisé dans `tailwind.config.ts` et `src/app/globals.css`.

## Architecture Validation Results

### Coherence Validation ✅
- **Compatibilité** : Stack Next.js + Drizzle + TanStack + Auth.js 100% compatible.
- **Cohérence** : Les patterns de nommage (snake_case DB / camelCase App) sont standardisés via Drizzle mapping.
- **Alignement** : La structure feature-driven supporte l'isolation des épiques.

### Requirements Coverage Validation ✅
- **Fonctionnel** : Chaque épique (1-5) possède une zone d'implémentation définie.
- **NFR-PERF** : Virtualisation validée comme pattern critique pour la grille.
- **NFR-SEC** : Proxy IA validé pour la protection des secrets OpenRouter.

### Implementation Readiness Validation ✅
- **Statut** : READY FOR IMPLEMENTATION.
- **Confiance** : Élevée (9/10).
- **Forces** : Isolation métier, stack moderne 2026, gestion sécurisée de l'IA.

### Architecture Completeness Checklist
- [x] Analyse de contexte et complexité
- [x] Stack technologique spécifiée (Next.js 16+, Drizzle 0.45)
- [x] Patterns de nommage et structure feature-driven
- [x] Mapping des 5 Épiques vers la structure physique
- [x] Validation de la conformité NFR (Perf, Sec, Rel)

### Implementation Handoff
1. Initialiser le projet via la commande `npx create-next-app@latest`.
2. Configurer le schéma Drizzle basé sur `database-schema.sql`.
3. Démarrer l'implémentation par l'**Epic 1 (Fondations & Connectivité)**.
