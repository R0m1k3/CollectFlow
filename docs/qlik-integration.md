# Intégration Qlik Sense — données réseau (~270 magasins)

Remplace les heuristiques (ranking / IA / score) par les vraies données réseau
La Foir'Fouille : **CA réseau, Qté vendue réseau, Nb magasins** par produit.

## Architecture livrée

| Élément | Fichier |
|---------|---------|
| Connecteur Qlik (NTLM + QIX websocket) | `src/lib/qlik-client.ts` |
| Cache lecture/upsert | `src/lib/qlik-network-cache.ts` |
| Table cache | `qlik_network_metrics` (`src/db/schema.ts`, créée par `scripts/db-init.js`) |
| Route de sync (admin) | `POST /api/qlik/sync` (`src/app/api/qlik/sync/route.ts`) |
| Bouton UI | `src/features/grid/components/sync-qlik-button.tsx` |
| Jointure grille | `enrichWithNetworkMetrics()` dans `src/features/grid/api/get-product-rows.ts` (Phase 8) |
| Colonnes grille | CA réseau / Qté réseau / Magasins (/270) / % présence (`heatmap-grid.tsx`) |
| Recherche produit (Qlik d'abord) | `src/lib/qlik-search.ts` → `src/features/produits/api/search-produits.ts` → `GET /api/produits/search` |

## Recherche produit — Qlik d'abord

La page `/produits` ne cherche **plus** dans le catalogue FF Nancy en premier :
le réseau référence bien plus de produits que Nancy, et ce sont précisément
ceux-là qu'on veut voir.

1. `searchQlikArticles()` — recherche de list object sur le champ libellé
   article. `SearchListObjectFor` applique un **OU** entre les mots (« tapis
   anti » ramenait 17 696 libellés sur l'app FF, et sélectionner ces 17 696
   valeurs faisait abandonner le cube en `code 15 — Request aborted`). On
   cherche donc mot par mot pour retenir le plus sélectif, on filtre en **ET**
   côté client, puis on sélectionne les valeurs retenues par numéro d'élément
   (`SelectListObjectValues`). La sélection restreint la dimension « Article
   Code » aux articles correspondants.
2. `fetchNetworkMetricsPlaywright()` — mesures réseau + détail mensuel sur la
   fenêtre 12 mois glissants (mois en cours exclu), puis `upsertNetworkMetrics()`
   pour que la fiche produit soit immédiatement servie depuis le cache.
3. `pgGetProduitsByCodeCentrale()` — rapprochement avec le catalogue Nancy.
   Un code absent = produit réseau que nous ne référençons pas (`?cc=` sur la fiche).

Repli : si Qlik est injoignable, la recherche retombe sur `pgSearchProduits()` et
la réponse le signale (`source: "db"`). Résultats mis en cache mémoire 10 min.

Champs de l'app FF (« Magasins Vision Consolidée ») : le code est `Article Code`,
le libellé `Article` (repli `article_libelle_ticket`, qui est le libellé ticket
tronqué), le fournisseur `Fournisseur` (repli `code_fournisseur`, qui ne porte
que le code). Ces préférences sont dans `CHAMPS_LIBELLE_PREFERES` /
`CHAMPS_FOURNISSEUR_PREFERES`, complétées par une heuristique pour les autres
apps. Si la détection tombe à côté, forcer :

```
QLIK_FIELD_ARTICLE_LIBELLE=<nom exact du champ libellé>
QLIK_FIELD_FOURNISSEUR=<nom exact du champ fournisseur>
```

Sans champ libellé exploitable, la recherche fonctionne encore par code centrale.

## Tendance réseau = 12 mois glissants stricts

`computeNetworkTrend()` reconstruit sa fenêtre à partir de la date du jour :
12 mois complets, **mois en cours exclu** (partiel, il tirait la pente vers le bas).
Les mois de la fenêtre absents du cache valent 0 (produit non vendu) ; ceux
antérieurs au premier mois réellement extrait sont écartés au lieu d'être
inventés à 0 (extraction plus courte que 12 mois).

Retirés : ranking (champs/query/colonnes), analyse IA (routes `/api/ai/*`, `bulk-ai-analyzer`,
dossier `ai-copilot`), score (`score-engine.ts`, colonne score).

## Auth — NTLM + ticket SSO (✅ TESTÉ, marche)

Flux implémenté dans `qlik-client.ts` / `scripts/qlik-discover.mjs` :
1. `GET /hub/` (non authentifié) → 302, on extrait le `targetId`.
2. **NTLM** (login `FFSCH`, **domaine vide**, pas `FOIRFOUILLE`) sur
   `/internal_windows_authentication/?targetId=…` → 302 vers `/hub/?qlikTicket=XXX`.
3. `GET /hub/?qlikTicket=XXX` → Qlik pose le cookie **`X-Qlik-Session`**.
4. Cookie + Xrfkey → QRS REST (✅) et Engine websocket.

⚠️ Domaine NTLM **vide** (comme `requests_ntlm("FFSCH", pwd)`). Forcer `FOIRFOUILLE` → 401.
Testé depuis l'extérieur : auth + QRS OK, **147 apps** côté admin (2 visibles pour FFSCH).

## Discovery (✅ FAITE)

**App réseau article-niveau = "Magasins Vision Consolidée"** (stream Magasin Big Data) :
- `QLIK_APP_NETWORK = 9872ee6e-d64a-4b43-984a-076bf1f7f647`
- dim `QLIK_DIM_CODE_ARTICLE_ID = fcd239e5-288b-4830-a047-0e3d7665d971` (**Article Code**)
- CA `QLIK_MEAS_CA_ID = 43a76088-86fa-402e-a80e-0efd7701b3e1` (**CA N**)
- Qté `QLIK_MEAS_QTE_ID = 7b40caf1-be4b-4811-8d45-50acde33e715` (**Quantité N**)
- nb mag `QLIK_MEAS_NBMAG_ID = 8b63fae5-db2f-4e4c-8618-f3e9d60b6b3b` (**Magasin Ventes Nb N**)

Ces GUID sont déjà les **défauts** dans `qlik-client.ts` (hypercube par `qLibraryId`).
(App "CA Foirfouille" stream Réseau = `65b3ad21-…` : pas de dimension article → écartée.)

⚠️ **À confirmer par un échantillon de hypercube** (5 lignes) : que `Article Code` = code
centrale `10000XXXXXX`, et que `Magasin Ventes Nb N` = nb magasins vendeurs. L'agent hermes
(Playwright) peut le faire.

### Limite extraction depuis l'extérieur
Le **websocket Engine renvoie 403** depuis un environnement externe (le proxy Qlik refuse
l'upgrade ws hors contexte navigateur ; l'extraction hermes qui marche réutilise une session
Playwright). Sur le **réseau corporate** (où tournera CollectFlow / où `/hub/` renvoie 401
NTLM direct), le ws raw devrait passer. À valider en déployant `POST /api/qlik/sync` sur leur
infra interne.

## Variables d'environnement (`.env.local`)

```
QLIK_HOST=reporting-magasins.lafoirfouille.fr
QLIK_USER=FFSCH
QLIK_PWD=<mot de passe courant>
QLIK_DOMAIN=          # VIDE (ne pas mettre FOIRFOUILLE — NTLM sans domaine)
QLIK_TLS_INSECURE=true
# Défauts déjà en dur dans qlik-client.ts (discovery 2026-06-20) :
QLIK_APP_NETWORK=9872ee6e-d64a-4b43-984a-076bf1f7f647
QLIK_DIM_CODE_ARTICLE_ID=fcd239e5-288b-4830-a047-0e3d7665d971
QLIK_MEAS_CA_ID=43a76088-86fa-402e-a80e-0efd7701b3e1
QLIK_MEAS_QTE_ID=7b40caf1-be4b-4811-8d45-50acde33e715
QLIK_MEAS_NBMAG_ID=8b63fae5-db2f-4e4c-8618-f3e9d60b6b3b
```

## RESTE À FAIRE

1. **Confirmer la sémantique des champs** (échantillon hypercube, via l'agent hermes/Playwright
   ou en déployant `/api/qlik/sync` en interne) : `Article Code` = code centrale `10000XXXXXX` ?
   `Magasin Ventes Nb N` = nb magasins vendeurs ? App bien réseau (270 magasins) ?

2. **Exécuter le sync depuis le réseau interne** : le websocket Engine renvoie 403 depuis
   l'extérieur. Déployer `POST /api/qlik/sync` sur l'infra interne FF pour valider l'extraction.

3. **Code centrale = `articles.artcentrale`** ✅ RÉSOLU. Confirmé via l'API FF
   `GET /api/articles/{no_id}` → champ `artcentrale` (ex `"10000167303"` = `10000`+6 chiffres).
   Ajouté au SELECT de `pgGetArticlesByFournisseur` (`a.artcentrale AS "codeCentrale"`) → propagé
   dans `ProductRow.codeCentrale` → jointure `enrichWithNetworkMetrics`. ⚠️ Vide pour la plupart
   des articles (seuls les référencés centralement en ont un). À valider que la valeur Qlik
   "Article Code" est bien au même format sur le premier vrai sync.

Tant que le sync interne n'est pas exécuté, la grille fonctionne en **dégradation propre** :
colonnes réseau vides, aucune erreur.
