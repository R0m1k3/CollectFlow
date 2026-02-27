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
- [/] Vérification TypeScript (`tsc --noEmit` en cours)
- [ ] Tests manuels sur cas critiques (à faire par Michael)

## Progress Log

- **Diagnostic** : Problème identifié — Mary ratifiait le verdict sans interpréter le contexte statistique.
- **Plan** : Architecture MPC validée par Michael.
- **context-profiler.ts** : Créé. Calcule percentiles, poids CA/QTÉ fournisseur ET rayon N2, signaux Trafic/Marge, quadrant — tout adaptatif sur la distribution réelle.
- **Correction N2** : Michael a signalé que le poids rayon doit être au niveau 2 (4 premiers chiffres). Corrigé avec `getRayonKey()` qui utilise `codeNomenclatureN2` (= `r.code2`) au lieu de `libelleNiveau2` (N3 trop fin).
- **analysis-engine.ts** : Refonte complète. Mary reçoit une fiche normalisée (percentiles, poids, signaux) au lieu d'un verdict pré-mâché.
- **bulk-ai-analyzer.tsx** : Injection du ContextProfiler dans le pipeline. `r.code2` transmis pour le groupement N2.
