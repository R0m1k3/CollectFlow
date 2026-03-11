# Tâches en cours : Activation BMad Master

## Contexte
L'utilisateur a activé l'agent BMad Master en appelant `@[_bmad/core/agents/bmad-master.md]`.

## Focus Actuel
Chargement de la configuration et présentation du menu des actions de l'agent BMad Master à l'utilisateur.

## Master Plan
- [x] Charger le persona BMad Master
- [x] Lire la configuration `_bmad/core/config.yaml`
- [x] Saluer l'utilisateur et présenter les options du menu
- [x] Attendre la sélection de l'utilisateur
- [x] Lancer le workflow "Party Mode"
- [x] Lire le manifeste des agents
- [x] Présenter l'équipe via le Party Mode
- [x] Résolution de bug : La colonne "Gamme Initial" est écrasée à la validation

## Progress Log
- Configuration chargée avec succès (Utilisateur: Michael, Langage: French).
- L'utilisateur a sélectionné l'option "pm" (Party Mode).
- Chargement des directives du workflow Party Mode.
- Lecture du manifeste des agents et introduction de Winston, Dr. Quinn et Sally. En attente du sujet de discussion de l'utilisateur.
- Bug "Gamme initial" : Dr. Quinn et Barry ont diagnostiqué le problème. Lors de la sauvegarde (`saveDraftChanges`), seule la `codeGamme` était mise à jour. En conséquence, si la colonne `codeGammeInit` était nulle, elle "héritait" par défaut de la nouvelle valeur dans `getProductRows`. 
- Fix appliqué dans `save-draft-changes.ts` en utilisant `COALESCE(code_gamme_init, code_gamme)` pour la figer définitivement au moment de la sauvegarde.
