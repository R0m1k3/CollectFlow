# Plan - Date de dernière entrée en stock par magasin

## Contexte
L'utilisateur souhaite ajouter la date de la dernière entrée en stock (dernière réception) pour chaque magasin dans la grille. Pour éviter d'alourdir la présentation visuelle, l'information sera intégrée de manière élégante et ergonomique directement sous forme d'infobulle premium (tooltip) au survol des badges de magasins ( Nancy "F" et Houdemont "H" ) sous la colonne Désignation.

## Focus Actuel
Spécification et implémentation du plan d'action structuré selon les piliers de l'architecture BMAD.

## Master Plan (BMAD)

### 1. [x] BUSINESS & UX CONCEPT
- [x] Valider la présentation ergonomique : l'information s'affichera dans l'infobulle (tooltip) au survol de chaque badge magasin (ex: "Frouard (Nancy)\nDernière entrée en stock : 12/05/2026").
- [x] Zéro surcharge visuelle sur la grille principale.

### 2. [x] MODEL
- [x] Modifier l'interface `ProductRow` dans `src/types/grid.ts` pour ajouter le champ facultatif `derniereLivraisonByStore?: Record<string, string>;` qui associera chaque magasin (`site`) à sa date de dernière réception.

### 3. [x] APPLICATION / API
- [x] Modifier `src/features/grid/api/get-product-rows.ts` (Phase 7) pour alimenter le dictionnaire `product.derniereLivraisonByStore` lors du parcours des lignes de `cube_stock`.

### 4. [x] DATA & PRESENTATION (UI)
- [x] Modifier `src/features/grid/components/heatmap-grid.tsx` pour récupérer et afficher cette date dans le `title` du badge magasin :
  - Si une date existe : `"Magasin : [Nom du magasin]\nDernière entrée en stock : [Date formatée]"`
  - Si aucune date : `"Magasin : [Nom du magasin]\nAucune entrée enregistrée"`
- [x] Vérifier la compilation globale avec `rtk tsc`.

## Progress Log
- **2026-05-26 14:52** : Initialisation du plan d'action BMAD dans `task.md`.
- **2026-05-26 15:47** : Implémentation du plan d'action complétée avec succès.
  - Champ `derniereLivraisonByStore` ajouté à l'interface `ProductRow`.
  - Mapping des dates de dernière réception par site alimenté lors du fetch du stock.
  - Intégration du tooltip premium ergonomique sur les badges de magasins dans la colonne Désignation.
  - Compilation vérifiée (aucune régression sur les fichiers modifiés).
