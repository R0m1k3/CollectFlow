# Plan — CollectFlow : interface simple, lisible et rapide

## Contexte

Analyse des 13 pages (+ layout, menu, en-tête, API, accès BDD). Constats principaux :

- **Lisibilité** : plus de 160 textes entre 8,5 et 11 px. Libellés en MAJUSCULES grasses gris pâle, sous le seuil de contraste AA. Jargon partout (Init., PCB, PRMP, Franco, Sync Qlik, CODEIN…). Libellés mi-anglais, mi-français (Dashboard, Analytics, Snapshots).
- **Incohérence** :
  - **Thème** : 5 pages sont figées en blanc (`bg-gray-50`) dans une application sombre. Les classes `dark:` suivent le réglage de l'OS, pas le bouton de thème.
  - **Composants** : 7 styles d'en-tête de page, 13 tableaux codés à la main, formateurs de nombres copiés dans 12 fichiers.
  - **Vocabulaire** : magasins nommés de 8 façons. « Réseau » désigne tantôt les ~270 magasins, tantôt nos 2.
- **Ergonomie** :
  - La recherche de l'en-tête ne filtre que la Grille, même depuis les autres pages.
  - L'utilisateur « Michael » est codé en dur dans l'en-tête.
  - La Grille affiche deux boutons « Valider » et deux exports, avec des droits différents.
  - Chaque chargement de page bloque tout l'écran (modale plein écran), et aucune page d'erreur n'existe.
- **Lenteur** :
  - Hors tableau de bord, aucune donnée n'est mise en cache, alors que les données FF ne changent qu'une fois par nuit.
  - Une Grille froide se reconstruit en 10 à 43 s. Ce calcul a lieu après chaque enregistrement, après chaque changement de magasin, et à chaque retour par le menu après un clic sur « Rafraîchir » : le paramètre `_refresh` reste collé à l'URL.
  - La Grille rend tout le tableau à chaque paquet de 150 lignes, donc un coût quadratique.
  - `exceljs` et `jspdf` sont chargés pour tous les utilisateurs.
  - Plusieurs requêtes SQL ne peuvent pas utiliser d'index : `TRIM(codein)`, `TO_CHAR(datmvt)`.
- **Bugs relevés** :
  - Après un filtre, la sélection multiple de la Grille vise d'autres produits.
  - Le filtre « passées » de Publicités ne s'applique pas (clé `passees` dans le filtre, `passee` dans les libellés).
  - L'erreur de chargement des Snapshots n'est jamais affichée.
  - La carte KPI du tableau de bord répète sa valeur principale.

**Choix validés** : thème **clair par défaut** ; menu **regroupé et renommé**, avec Snapshots et Exports fusionnés en « Historique » ; livraison **par lots, une PR par lot**, sur la branche `claude/keen-maxwell-hbtho6`.

Conventions du dépôt :
- préfixe `rtk` sur toutes les commandes ;
- commits en français ;
- plan de chaque lot rangé selon BMAD (Business / Model / API / Data, `.agents/rules/general.md`).

---

## Lot 1 — Vitesse et bugs, sans changement visuel (PR 1)

Risque faible, gain immédiat.

**Grille (client)**
- `src/features/grid/components/grid-client.tsx` :
  - retirer `_refresh` de la requête mémorisée dans `activeGridQuery` (l.86-91), puis le supprimer de l'URL après usage avec `router.replace` ;
  - sortir `code1` et `code2` des dépendances du chargement : le serveur ne les lit pas.
- `grid-client.tsx:152-156` : accumuler les paquets reçus et ne mettre à jour le store que toutes les ~250 ms, plus une fois à la fin, au lieu de reconstruire à chaque paquet.
- `heatmap-grid.tsx` :
  - ajouter `getRowId: r => r.codein` (corrige le bug de sélection) ;
  - mémoriser `MONTHS_12` sur sa clé texte (l.628) ;
  - retirer `transition-all` sur les lignes et le flou du bandeau d'en-tête.
- `export-dropdown.tsx` :
  - `exceljs`, `jspdf` et `jspdf-autotable` passent en `await import()` dans les gestionnaires ;
  - le composant est chargé via `next/dynamic` ;
  - remplacer `useGridStore()` sans sélecteur (l.12).
- Créer `src/lib/format.ts` : instances `Intl.NumberFormat` créées une seule fois, plus `fmtEur`, `fmtQte`, `fmtPct`, `fmtDate`. Les cellules de la Grille l'utilisent ; les autres pages au lot 3.

**Grille (serveur)** — `src/features/grid/api/get-product-rows.ts`
- Lancer la requête des métriques Qlik et celle du dernier snapshot dans le même `Promise.all` que la phase 1 (l.130-146, 410, 416).
- `qlik-network-cache.ts` : ne sélectionner que les colonnes utiles, sans le JSONB `metricsByMonth`.
- Cache mémoire :
  - le borner (LRU d'environ 30 entrées) ;
  - garder la déduplication des calculs en cours même en `forceRefresh` ;
  - transmettre `request.signal` depuis `src/app/api/grid/rows/route.ts`.
- Après un enregistrement, **mettre à jour en place** le `codeGamme` des lignes en cache au lieu d'invalider tout le cache (`save-draft-changes.ts:73`). Nouvelle fonction `patchGridRowsCache()` à côté de `invalidateGridRowsCache()`.
- Supprimer les `console.log` des chemins chauds : `get-product-rows.ts` (l.83, 123, 148, 433, 444, 622) et `pg-ff-client.ts` (l.99, 300-303, 431, 516).

**Cache des données FF jusqu'à la synchro nocturne**
- Créer `src/lib/ff-cache.ts` : enveloppes `unstable_cache` étiquetées `ff-data`, durée 6 h, sur le modèle déjà en place dans `dashboard/page.tsx:4-8`. Elles couvrent :
  - les 3 requêtes de stock ;
  - le hit-parade (clé : dates) ;
  - les CA par fournisseur et par nomenclature (clé : mois et mode) ;
  - `pgGetFournisseurs` ;
  - `getFournisseurs` de la Grille ;
  - la dernière réception par fournisseur ;
  - `pgGetCommandesAuto`.
- Publicités : `fetch` avec `next: { revalidate, tags }` au lieu de `no-store`.
- À la fin du cycle nocturne (`src/features/admin/api/sync-scheduler.ts`) : invalider l'étiquette `ff-data`, puis préchauffer le tableau de bord et le stock.
- Points à vérifier :
  - la signature de `revalidateTag` en Next 16 ;
  - que les valeurs mises en cache passent en JSON (les `Date` deviennent des chaînes).

**Base de données et API**
- `src/db/index.ts` :
  - pool rangé dans `globalThis` ;
  - `options: "-c statement_timeout=60000 -c max_parallel_workers_per_gather=0"` et `application_name`.
  - `pgNoParallel` (`pg-ff-client.ts:25-33`) n'a alors plus besoin de BEGIN/SET/COMMIT : 3 allers-retours de moins par requête.
- `AbortSignal.timeout` sur tous les appels à l'API FF : `api-ff-client.ts`, `publicites/page.tsx`, appels du tableau de bord.
- Index des tables applicatives, dans `scripts/db-init.js` et `src/db/schema.ts` :
  - `session_snapshots(code_fournisseur, created_at DESC)` ;
  - `session_snapshots(user_id, type, created_at DESC)`.
- Divers :
  - Commandes auto : supprimer le double rechargement, en retirant `router.refresh()` puisque `revalidatePath` est déjà appelé (`cadencier-client.tsx:172-177`).
  - Synchronisation : PATCH envoyé à la sortie du champ, plus à chaque frappe (`admin/synchronisation/client.tsx:209-237`).
  - Paramètres : un seul appel à `getSavedDatabaseConfig`.
  - `log-capture.ts` : sortie immédiate si aucune capture n'est ouverte.

**Bugs fonctionnels**
- Publicités : aligner la clé `passees`/`passee` (`publicites/client.tsx:141, 256`).
- Historique : afficher l'état d'erreur (`snapshot-list.tsx:133`).
- Tableau de bord : la carte KPI répète sa valeur (`dashboard/page.tsx:183-185`).
- Barre de résumé de la Grille : `filters.magasin` n'est jamais renseigné, donc les snapshots enregistrent toujours « TOTAL » (`floating-summary-bar.tsx:104`).

---

## Lot 2 — Socle visuel, menu et vocabulaire (PR 2)

**Thème et typographie** — `src/app/globals.css`, `theme-provider.tsx`
- `defaultTheme="light"`.
- Ajouter `@custom-variant dark (&:where(.dark, .dark *));` pour que les classes `dark:` suivent le bouton de thème.
- Ajouter `@import "tw-animate-css";`.
- Faire correspondre les jetons shadcn (`--color-background`, `--color-muted-foreground`, `--color-accent`…) aux variables de l'application.
- Contraste AA (≥ 4,5:1) pour `--text-muted` en clair et en sombre.
- Échelle typographique :
  - rien sous **12 px** ;
  - cellules de tableau à 13-14 px ;
  - libellés en casse normale, sans MAJUSCULES `font-black tracking-widest`.
- Une seule famille de boutons (fusion de `.apple-btn-*` et `.btn-action-*`) ; définir ou retirer les classes inexistantes (`apple-btn`, `--border-subtle`, `--surface-tertiary`).

**Composants partagés** — dans `src/components/ui/`
- `PageHeader` : titre, phrase d'explication, actions.
- `Card` / `Section`, `StatCard` (KPI avec écart N-1).
- `Badge`, `DeltaBadge`, `StoreBadge`, `GammeBadge`.
- `Tabs`, avec l'onglet actif dans l'URL.
- `Select`, `SearchInput`.
- `EmptyState`, `ErrorState`, `Skeleton`.
- `ConfirmDialog` sur `ui/dialog`. Il remplace `window.confirm`, `alert()` et les 3 modales faites à la main.
- Notifications discrètes (`sonner`, standard shadcn) à la place de `SuccessModal` pour les succès.
- **`DataTable<T>`** : généralisé depuis `StockTable<T>` (`stock-negatif/client.tsx:168-384`), qui gère déjà colonnes, tri, recherche, pagination et export. Ajouter en-tête collant, état vide, et infobulle sur les en-têtes.

**Sources uniques**
- `src/lib/magasins.ts` : 292 → « Frouard (Nancy) », 579 → « Houdemont », TOTAL → « Nos 2 magasins ». Il remplace `SITE_NAMES` (dashboard), `months.ts:91-94` et les 3 copies de `SITES`.
- `src/lib/glossaire.ts` : libellé clair et infobulle pour chaque terme métier. Exemples :
  - Gamme A–Z avec son sens, à reprendre de `bulk-action-toolbar.tsx:8-12` ;
  - Réseau = environ `NB_MAGASINS_RESEAU` magasins (`network-trend.ts:13`) ;
  - Franco, PCB, PRMP, GTIN, N-1, Init.
- Règles de vocabulaire :
  - « Réseau » = les ~270 magasins uniquement ; nos 2 magasins = « Nos magasins » ;
  - Famille et Sous-famille identiques partout ;
  - vouvoiement partout.
- Seuils de marge : une seule constante, au lieu de 25/15 % sur le tableau de bord et 40/25 % sur la fiche.

**Menu** — `src/components/shared/sidebar.tsx`
- Menu déplié par défaut, en groupes :
  - **Au quotidien** : Accueil, Révision d'assortiment, Recherche produit, Stocks à surveiller, Commandes fournisseurs.
  - **Analyses** : Meilleures ventes, Ventes par mois, Publicités.
  - **Historique** : nouvelle page `/historique` qui fusionne Snapshots et Exports, avec un onglet par type ; l'onglet Exports est réservé aux admins. `/snapshots` et `/exports` y redirigent.
  - **Administration** : Synchronisation, Paramètres.
- Icônes distinctes pour chaque entrée.
- `src/middleware.ts` : protéger aussi côté serveur la partie admin de l'historique.

**En-tête et coquille**
- `header.tsx` :
  - retirer la recherche globale, qui ne filtrait que la Grille ; la Grille garde la sienne ;
  - afficher le vrai utilisateur ;
  - réglages personnels (thème, densité de la Grille) dans un menu utilisateur accessible à tous.
- Remplacer les 11 `loading.tsx` (modale plein écran) par des squelettes de page non bloquants.
- Ajouter `app/(dashboard)/error.tsx` (message clair et bouton « Réessayer ») et `not-found.tsx`.
- Titre de l'application en français (`app/layout.tsx`).

---

## Lot 3 — Migration des pages, une à une (PR 3, découpable en 3a/3b)

Règle commune à chaque page :
- `PageHeader` avec une phrase « à quoi sert cette page » ;
- `DataTable` et composants partagés, jetons du thème ;
- retrait des enveloppes `min-h-screen bg-gray-50 p-6` (double marge) ;
- noms de magasins depuis `magasins.ts`, infobulles depuis `glossaire.ts` ;
- états vide et erreur explicites.

| Page | Changements spécifiques |
|---|---|
| Accueil (`dashboard`) | Cartes `StatCard`. Section « Hit Parade » renommée « Top 10 d'hier ». Chaque produit mène à sa fiche. Couleurs codées en dur remplacées par les jetons. Message d'erreur compréhensible, sans trace technique. |
| Révision d'assortiment (`grid`) | **Barre d'outils** : un seul « Enregistrer » (dans la barre de résumé), un seul menu Export, un seul « Actualiser », avec les mêmes droits partout (`isAdmin` calculé côté serveur via `auth()` dans `grid/page.tsx`). Les actions rares (Non travaillés, Vues, Colonnes, Synchro Qlik) passent dans « Plus d'options ». **Libellés** : gammes affichées avec leur sens (« A — Cœur ») ; menu Colonnes avec de vrais libellés, pas les identifiants ; « / 270 » remplacé par `NB_MAGASINS_RESEAU`. **Chargement** : la superposition floue est remplacée par une barre de progression légère. **Accueil fournisseur** : une phrase-guide. |
| Recherche produit (`produits`) | Tailles ≥ 12 px dans `fiche.tsx`, `results.tsx` et `opportunites.tsx`. Infobulles PCB, PRMP, GTIN. Famille et Sous-famille alignées. Message de chargement sans « Qlik Sense ». |
| Meilleures ventes (`hit-parade`) | `DataTable` paginé ; état vide ; « % Marge » triable. Export via `exceljs` en import dynamique, ce qui permet de retirer `xlsx`. |
| Stocks à surveiller (`stock-negatif`) | Base du `DataTable`. En-têtes Excel lisibles (« Code article » au lieu de CODEIN, etc.). Noms de magasins. |
| Publicités | Le tri et le filtre magasin s'appliquent à l'ensemble des données, pas seulement à la page de 50. Infobulles « Taux de sortie » et « % CA total ». |
| Commandes fournisseurs (`commandes-auto`) | Onglets dans l'URL. Confirmation avant suppression. Erreurs affichées en notification. Retour visuel à l'enregistrement d'une fréquence. Infobulle « Franco ». |
| Ventes par mois (`analytics`) | Dernier **mois complet** par défaut. Mois en clair (« oct. 2026 vs oct. 2025 »). Recherche, tri, export, état vide. |
| Historique | Page fusionnée (lot 2), libellés de session lisibles. |
| Paramètres | Onglets Connexions / Utilisateurs / Clés API / Journal. Un bouton « Enregistrer » par section (le bouton collant trompeur disparaît). Thème et densité déplacés dans le menu utilisateur. |
| Synchronisation | Unités affichées (« jours », « heures »). Filtres en casse normale. Libellés sans jargon (« Tour bouclé » → « Tous les fournisseurs traités »). |
| Connexion | Libellés lisibles. Slogan « Propulsée par l'IA » retiré. Rendu clair. |

---

## Lot 4 — Optimisations lourdes (PR 4)

**Grille servie depuis l'instantané `grid_rows`** (le plus gros gain)
- La table est déjà remplie chaque nuit avec exactement les `ProductRow` du magasin TOTAL : `persistGridSnapshot` dans `get-product-rows.ts`, et `sync-scheduler.ts:173`.
- Ajouter `readGridRowsPayload(codeFournisseur)` dans `src/lib/grid-store.ts`, qui lit `payload::text` et l'envoie tel quel, sans analyse ni réencodage.
- Superposer ensuite la gamme INIT à jour (`refreshGammeInit`) et les gammes du dernier snapshot.
- Si l'instantané est trop ancien, relancer le calcul en arrière-plan (stale-while-revalidate).
- Ouverture à froid : de 10-43 s à environ 1-2 s.

**Changement de magasin instantané**
- Toujours charger TOTAL : les lignes portent déjà le détail par magasin.
- Bascule côté client avec `setActiveMagasin` et `history.replaceState`, sans aller-retour serveur (`grid-filter-bar.tsx:100-105`).
- Le rattrapage via l'API FF (`reconcileSelectedStoreFromMensuelApi`) devient une petite requête séparée, `/api/grid/rows/store-patch`, appliquée quand elle arrive.

**Rendu de la Grille**
- `React.memo` sur `HeatmapGrid`, `GridFilterBar` et `FloatingSummaryBar`.
- `useSaveDrafts` déplacé dans le bouton Enregistrer.
- En-tête de tableau mémorisé ; `useFlushSync: false` sur le virtualiseur.
- Largeurs de colonnes en variables CSS.
- `persist` de zustand sans les lignes, et limité en fréquence.
- Tendance réseau et texte de recherche calculés une seule fois par ligne à la réception ; le filtre global ne porte plus que sur ce texte.
- Lignes gardées en mémoire au retour sur la Grille (même fournisseur, moins de 10 min) : pas de `setRows([])`.

**SQL sans index utilisable**

À valider par `EXPLAIN ANALYZE` sur la base réelle avant fusion : le schéma des tables FF n'est pas dans le dépôt.

- Fiche produit (`get-produit-fiche.ts`, `pg-ff-client.ts:1737-2045`) : résoudre `no_id` une fois, puis filtrer sur les clés ; lecture du cache Qlik dans le même `Promise.all` ; supprimer la double recherche du chemin `?cc=`.
- Ventes par mois (`pg-ff-client.ts:827-885`) : plages de dates au lieu de `TO_CHAR`.
- Stocks : réécrire `pgGetStockSansVente` (l.1198-1235) en agrégeant d'abord par (article, site). Charger seulement l'onglet actif.
- Meilleures ventes (l.922-991) : jointure sur `artnoid` / `no_id`.
- Commandes : la dernière réception est limitée aux fournisseurs du cadencier et à une fenêtre de dates ; appels « franco » à concurrence bornée, avec délai maximal ; un `Suspense` par onglet.
- Tableau de bord (l.623-797) : une seule requête SQL sur `cube_stock`, en réutilisant `pgGetStockForCodeins`, au lieu de ~60 appels HTTP. Cache par date, préchauffé après la synchro.
- `/api/v1/grid` : pagination par curseur (keyset) au lieu d'OFFSET ; COUNT une seule fois.
- `api-auth.ts` : `last_used_at` mis à jour au plus une fois par minute.

**Nettoyage**
- Dépendances inutilisées : `@tanstack/react-query`, `@google/genai`, `ai`, `react-markdown`, et `xlsx` après le lot 3.
- Code mort : `supplier-selection.tsx`, `financial-cell.tsx`, `ui/textarea.tsx`, `getGridData` et `getAvailableNomenclature` (`grid/actions.ts`).

---

## Hors périmètre, à signaler

`src/features/settings/actions.ts` ne vérifie aucun droit. Tout utilisateur connecté peut lire l'URL de la base, le mot de passe Qlik et les clés IA, et réécrire la configuration. Ce point est proposé en tâche séparée.

## Vérification (à chaque lot)

1. **Contrôles automatiques** :
   - `rtk tsc` : aucune nouvelle erreur par rapport à `tsc_errors.log`, car `ignoreBuildErrors` est activé.
   - `rtk lint`.
   - `rtk next build` : comparer le JS de premier chargement de `/grid` avant et après (lot 1 : − `exceljs` / `jspdf`).
2. **Visuel** :
   - `rtk npm run dev`, puis Playwright (Chromium préinstallé) pour capturer chaque page en clair et en sombre, en 1920 et 1366 px de large.
   - Un script dans la page signale tout texte calculé sous 12 px et tout élément `bg-white` en mode sombre.
3. **Vitesse** :
   - mesurer le temps de réponse de `/api/grid/rows` (froid, chaud, après enregistrement), et de `/stock-negatif` et `/hit-parade` au 1er puis au 2e chargement ;
   - objectif : 2e visite en moins de 200 ms, Grille froide en moins de 2 s au lot 4.
4. **Recette manuelle sur l'environnement réel** (ce conteneur n'a pas accès à PostgreSQL FF, à l'API FF ni à Qlik) :
   - gros fournisseur ;
   - changement de magasin instantané ;
   - enregistrer puis rouvrir sans attente ;
   - sélection multiple après filtre, sur les bons produits ;
   - après « Actualiser », un retour par le menu ne force plus le recalcul ;
   - exports Excel identiques.

---

## Suivi — Lot 1 réalisé

Écarts par rapport au plan, décidés pendant l'implémentation :

- **Cache FF** : un cache mémoire dédié (`src/lib/ff-cache.ts`) remplace `unstable_cache`. Deux raisons :
  - `unstable_cache` sérialise en JSON, ce qui casse les `Map` et les `Date` ;
  - `revalidateTag` ne peut pas être appelé depuis la synchro nocturne, qui tourne hors requête.

  Fonctionnement :
  - durée de vie de 30 min (`FF_CACHE_TTL_S`), et 10 min pour les publicités ;
  - les appels simultanés partagent une seule requête ;
  - les erreurs ne sont jamais gardées ;
  - le cache est vidé en fin de synchro nocturne.
- **`statement_timeout`** : activé seulement si `PG_STATEMENT_TIMEOUT_MS` est défini, pour ne pas couper les longs calculs nocturnes.
- **Colonnes Qlik** : non modifié. `metricsByMonth` sert à la courbe « nombre de magasins vendeurs ».
- **Carte KPI du tableau de bord** : non modifiée. La ligne « Hier / N-1 » est une comparaison voulue, pas un doublon.
- **Préchauffage après la synchro** : reporté. L'invalidation suffit, la première visite recharge.
