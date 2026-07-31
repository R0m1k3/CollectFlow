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
2. Les **mesures réseau sortent du même cube**, dans la **même session Qlik** :
   fenêtre 12 mois glissants sélectionnée sur le champ `Date`, master measures
   résolues par titre, cube trié par quantité réseau décroissante (les meilleures
   ventes en tête, donc pas besoin de lire tout l'ensemble sélectionné).
   Elles sont ensuite persistées par `upsertNetworkMetrics()`.

   ⚠️ Ne **jamais** relancer `fetchNetworkMetricsPlaywright()` pendant une
   recherche : deux sessions concurrentes sur la même app, dont une avec une
   grosse sélection, et l'Engine coupe les requêtes (`code 15`). C'est ce qui
   faisait échouer la recherche alors que la sync de la Grille — seule sur le
   serveur — fonctionnait. Le détail mensuel vient donc du cache, et la fiche
   produit garde son bouton « Actualiser depuis Qlik » pour l'extraire à la
   demande sur un seul code.
3. `pgGetProduitsByCodeCentrale()` — rapprochement avec le catalogue Nancy, sur
   **deux clés candidates** : la dimension « Article Code » et le champ
   `article_no_centrale`, qui n'ont pas le même format sur l'app FF. Un code
   absent = produit réseau que nous ne référençons pas (`?cc=` sur la fiche).

Plafonds mesurés en production : sélectionner les 13 446 libellés contenant
« tapis » prenait 81 s puis 486 s avant d'abandonner. La sélection est donc
plafonnée à **300 valeurs** (`MAX_VALEURS_SELECTION`) et une seule recherche
tourne à la fois.

L'API est **asynchrone** : `POST /api/produits/search?q=…` démarre un job et rend
la main tout de suite, `GET` renvoie l'avancement puis le résultat (polling client
toutes les 2 s). Une requête HTTP maintenue pendant toute l'extraction se faisait
couper par le reverse proxy, qui répond une page HTML — le client échouait sur
« Unexpected token '<' … is not valid JSON ». Même schéma que `POST /api/qlik/sync`.

Repli : si Qlik est injoignable, la recherche retombe sur `pgSearchProduits()` et
la réponse le signale (`source: "db"`). Un résultat Qlik exploitable est mis en
cache mémoire 10 min ; un repli ne l'est pas, sinon une panne passagère resterait
figée.

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

## ⚠️ Les master measures « N » ignorent la sélection Date

**Constat de production, vérifié arithmétiquement.** Avec août 2025 seul
sélectionné, le cube renvoyait `qte=164` / `ca=2 220,75 €` — soit exactement la
somme de janvier à juillet 2026. « CA N », « Quantité N » et consorts sont des
mesures **cumul année en cours**, insensibles au champ `Date`.

Trois conséquences, toutes observées :

- les totaux réseau de la Grille étaient un **cumul année en cours** (mois
  courant partiel inclus), pas 12 mois glissants ;
- les mois de l'année précédente non couverts par « Quantité COMP » (août à
  décembre, en juillet) restaient **vides sur tous les articles** ;
- la passe de rattrapage y recopiait le **total de période**, d'où cinq mois
  identiques à 164 dans `qteByMonth`.

Aucune sélection ne corrige cela. Le chemin nominal agrège donc **directement les
champs de faits**, qui respectent les sélections :

| Rôle | Expression (surchargeable) |
|------|----------------------------|
| Quantité | `QLIK_EXPR_QTE` — défaut `Sum(quantite)` |
| CA | `QLIK_EXPR_CA` — défaut `Sum(ca_ht)` |
| Magasins | `QLIK_EXPR_NBMAG` — défaut `Count(DISTINCT [Magasin Code])` |
| Marge | `QLIK_EXPR_MARGE` — défaut `Sum(marge)` |

Un seul cube `[Article Code, Mois]` couvre les 12 mois : ni passe N-1 ni
rattrapage — c'est exactement ce qu'ils compensaient. Les totaux deviennent la
**somme des 12 mois de la fenêtre**.

Garde-fous : « Quantité N » est incluse dans le cube pour **calibrage**, et le
log compare les deux sur les mois de l'année en cours, seul périmètre où la
master measure est juste :

```
[qlik-pw][expr] 485210 lignes, quantité totale=…, calibrage année 2026 : 4812/4830 mois conformes à « Quantité N »
```

Un calibrage faible signale une expression à ajuster (filtre `flag_type_mvt`,
`ca_ttc` plutôt que `ca_ht`…). Il n'existe plus de repli automatique vers les
master measures annuelles : quantité totale nulle, champ Date invalide, erreur
Engine ou somme incohérente font échouer la synchronisation et laissent le cache
précédent intact.

Après sélection de la fenêtre, l'extracteur vérifie deux invariants avant tout
upsert :

1. la somme de toutes les lignes `[Article Code, Mois]` est égale au total Qlik
   sans dimension calculé avec les mêmes sélections ;
2. pour chaque article, la quantité réseau totale est exactement la somme de ses
   12 mois. Les mois sans ligne de faits sont alors seulement matérialisés à `0`.

Une extraction interrompue ou partielle n'est jamais publiée.

### Valider les expressions sur le vrai serveur

`scripts/qlik-validate.mjs` répond aux deux questions ouvertes en une exécution,
**depuis un réseau qui atteint Qlik** (le serveur est filtré par IP : injoignable
depuis l'extérieur, la passerelle d'egress tombe en `connection timeout`) :

```
docker exec -e QLIK_PWD='<mot de passe>' -it <conteneur> node scripts/qlik-validate.mjs
```

Il affiche les expressions réelles des master measures, puis un tableau mois par
mois comparant `Sum(quantite)` / `Sum(ca_ht)` / `Sum(ca_ttc)` /
`Count(DISTINCT [Magasin Code])` aux mesures « N » — sur les mois de l'année en
cours (où elles doivent coïncider) comme sur ceux de l'année précédente (où les
mesures « N » sont censées être à 0). Il affiche enfin `Article Code`,
`article_no_centrale` et `article_codein` côte à côte, pour trancher la clé de
jointure avec `articles.artcentrale`.

Lecture seule : sélections en soft lock, objets de session détruits.

### La sélection Date filtre-t-elle seulement quelque chose ?

Question restée sans réponse tant que seules des mesures **insensibles à la
sélection** étaient utilisées : rien ne prouvait que `Date` bornait quoi que ce
soit. Le chemin par expressions le vérifie désormais avant d'extraire, avec un
total de contrôle (`Sum(quantite)` sans dimension) :

```
[qlik-pw][expr] contrôle Sum(quantite) sans filtre date = 12345678
[qlik-pw][expr]   champ « Date » → 0 (0% du total sans filtre)
[qlik-pw][expr]   champ « Date calendrier » → 3456789 (28% du total sans filtre)
[qlik-pw][expr] champ date retenu : « Date calendrier »
```

Un champ n'est retenu que s'il donne un total **non nul et strictement inférieur**
au total sans filtre — 0 % signifie que la sélection ne matche rien, 100 % qu'elle
n'a aucun effet. Candidats essayés dans l'ordre : `QLIK_DATE_FIELD` (si défini),
`Date`, `Date calendrier`, `Date_Key` (celui-ci sélectionné au format `AAAAMMJJ`).

Si aucun ne filtre, l'extraction échoue explicitement plutôt que de produire une
fenêtre fausse. Chaque sélection d'un candidat rejeté est effacée avant l'essai
suivant ; autrement un premier candidat à zéro contaminait tous les contrôles
suivants.

## La passe de rattrapage a été supprimée

Elle ré-extrayait un mois vide en ne sélectionnant que ses dates. Les master
measures ignorant la sélection Date, le cube lui renvoyait le **total de période**
qu'elle recopiait dans chaque mois manquant : d'où les plateaux identiques d'août
à décembre (87 648 douze mois de suite sur un article) et les tendances
« −162 % » entièrement fabriquées.

Un mois qu'on ne sait pas extraire doit rester **absent**, jamais rempli d'une
valeur plausible.

## Mois vides de la fenêtre glissante

Les mesures « N » de l'app sont bornées à une année civile. Quand la fenêtre
12 mois glissants chevauche deux années (le cas 11 mois sur 12), le chemin
« dimension Mois » sélectionne les 365 jours d'un coup et la mesure ne se résout
que sur une seule année : les mois de l'année précédente ressortent vides.
« Quantité COMP » ne rattrape que les mois ayant un comparable dans l'année en
cours — d'où, en juillet 2026, un trou observé d'août à décembre 2025 sur
**tous** les articles.

Le chemin daté repose uniquement sur les expressions de faits et un cube unique
`[Article Code, Mois]`. Après validation de la fenêtre et du total, chaque
article reçoit exactement les 12 clés attendues. Une clé absente du cube signifie
alors réellement « aucun fait sur ce mois » et vaut `0`; avant cette validation,
aucun zéro n'est inventé.

`QLIK_MONTH_DIM=0` ou `QLIK_USE_EXPR=0` désactive désormais un prérequis et fait
échouer la synchronisation datée : ces options ne peuvent plus réactiver un
chemin connu comme incorrect.

⚠️ Les données déjà en cache gardent leurs zéros : il faut relancer la sync Qlik
pour les corriger.

## Coût de `SelectValues` sur « Article Code »

Mesuré en production : **8 à 100 s par appel**, quasi indépendamment du nombre de
valeurs — le moteur balaie un symbole de plus d'un million d'entrées. Avec 7 200
codes en lots de 300, cela faisait 24 appels, ~15 min de sync, et la session Qlik
mourait avant la fin (`Socket closed`, puis `Execution context was destroyed`).

La dimension Mois livrant déjà tous les mois d'un coup, rien n'oblige à découper
les codes : le chemin mensuel fait donc **une seule sélection pour tous les codes**
et **un seul cube paginé** (la lecture des pages coûte ~50 ms). Repli automatique
sur les lots si l'Engine refuse. Même principe pour `rattraperMoisVides()` : une
sélection de codes, puis seule la fenêtre de dates change d'un mois à l'autre.

La sonde de diagnostic de fin de sync a été retirée : elle refaisait une sélection
complète des codes et des 365 jours pour rien.

### Aucun résultat partiel dans le cache

Le script in-page conserve des points de contrôle à des fins de diagnostic, mais
une synchronisation datée interrompue est refusée intégralement. Le cache garde
sa dernière version complète jusqu'à la réussite d'une nouvelle extraction.

## Tendance réseau = 12 mois glissants stricts

`computeNetworkTrend()` reconstruit sa fenêtre à partir de la date du jour :
12 mois complets, **mois en cours exclu** (partiel, il tirait la pente vers le bas).
La tendance n'est affichée que si les 12 clés sont explicitement présentes dans
le cache. Les anciennes séries partielles de deux ou trois mois sont donc
refusées au lieu d'être présentées comme une tendance.

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
