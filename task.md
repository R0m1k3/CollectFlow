# Tâches en cours : Refonte du Moteur de Recommandation IA (Multi-Dimensionnel)

## Contexte

Mary (IA) donnait des recommandations basées sur le score brut sans analyse contextuelle. La refonte introduit un profilage statistique adaptatif (poids CA, poids QTÉ, marge, profil quadrant) avant de soumettre à l'IA.

## Focus Actuel

**Implémentation** : Création du `context-profiler.ts`, refonte du prompt `analysis-engine.ts`, injection dans `bulk-ai-analyzer.tsx`.

## Master Plan

- [x] Diagnostic et analyse du pipeline existant
- [x] Rédaction du plan d'implémentation (validé par Michael)
- [x] Créer `context-profiler.ts` (profilage adaptatif, percentiles dynamiques)
- [x] Modifier `ai-analysis.types.ts` (ajout `contextProfile` + `codeNomenclatureN2`)
- [x] Refondre `analysis-engine.ts` (nouveau prompt Mary v3)
- [x] Modifier `bulk-ai-analyzer.tsx` (injection ContextProfiler + `r.code2`)
- [ ] Vérification TypeScript (`tsc --noEmit` en cours)
- [x] Refonte esthétique des paramètres (Boutons Glossy, Glassmorphism)
- [x] Créer le Walkthrough
- [ ] Tests manuels sur cas critiques (à faire par Michael)

## Progress Log

- **Agent Architecte (Timeout)** : Intervention structurelle sur l'entonnoir d'analyse :
  - **Client-Side (AbortController)** : Timeout poussé de 25s à 50s pour supporter les requêtes des LLM denses (ex: M37).
  - **Server-Side (N+1 Query)** : Suppression d'une requête BDD redondante invoquée par chaque produit, éliminant ~100 appels BDD par lot.
- **Agent Architecte (Gamme C)** : Prompt v5 → Mary ne recommande plus que A ou Z. Gamme C interdite (réservée saisonniers). Garde-fou C→A côté client. Concurrence réduite à 2 workers, max_tokens réduit à 150.
- **Bouton Analyse IA** : Refactorisé en `apple-btn-secondary` (sobre, conforme PRD Apple-style) avec icône Sparkles colorée en accent.
- **Vérification** : Walkthrough documenté et système fluidifié.
