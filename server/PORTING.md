# Portage Rust — conventions de travail

Ce document fixe le contrat entre le serveur Rust (`server/`) et l'interface
React (`src/`, compilée en SPA par Vite). Le code TypeScript d'origine (Next.js)
reste la **référence fonctionnelle** : chaque module Rust en est la traduction
fidèle (mêmes requêtes SQL, mêmes règles, mêmes messages, mêmes formes JSON).

## Socle déjà en place (ne pas réécrire)

| Besoin | Rust |
|---|---|
| Pool PostgreSQL (base app + recopie FF) | `crate::db::pool()? -> PgPool` (remplaçable à chaud, `db::refresh()`) |
| Ligne → JSON générique | `db::row_to_json`, `db::rows_to_json` |
| Lecture tolérante (`Number(r.x) \|\| 0`, `String(r.x ?? "")`) | `db::get_f64`, `db::f64_or0`, `db::get_string`, `db::string_or_empty` |
| Date ISO façon `toISOString()` | `db::iso(NaiveDateTime)`, `db::iso_utc` |
| Réglages `data/.db-config.json` | `config::read_config()`, `config::write_config(patch)`, `config::data_dir()`, `config::env_number(...)` |
| Cache FF (`cachedFF`) | `ff_cache::cached(key, CacheOpts { ttl, cache_if }, \|\| async { … }).await`, `ff_cache::invalidate()` |
| Journaux de job (`startCapture`…) | `logcapture::{start_capture, stop_capture, read_capture, list_captures}` |
| Session (routes internes) | extracteurs `auth::SessionUser`, `auth::AdminUser` (401/403 `{ error }`) ; `auth::Token` (jeton brut) ; `auth::require_session(token)` / `require_admin(token)` |
| Auth `/api/v1` | extracteur `auth::ApiAuth` (clé d'API ou session, erreurs au format v1) ; `ctx.require_admin()` |
| Enveloppe `/api/v1` | `api_v1_response::{ok, fail, build_pagination, ApiErrorCode}` |
| Erreurs | `error::{AppError, AppResult}` — `AppError` implémente `IntoResponse` (`{ error }`) et `From<anyhow::Error / sqlx::Error / reqwest::Error>` |
| Magasins / gammes | `domain::{MAGASINS, CODE_TOUS_MAGASINS, nom_magasin, est_gamme_valide}` |
| Actions / pages | `rpc::{Ctx, Handler, json}` + macro `handler!(fonction)` |

## Organisation

Chaque module possède son répertoire `server/src/<module>/` et expose dans son
`mod.rs` :

```rust
pub fn router() -> axum::Router;                         // routes HTTP (chemins identiques à Next.js)
pub fn actions() -> Vec<(&'static str, rpc::Handler)>;    // ex. ("getUsers", handler!(get_users))
pub fn pages() -> Vec<(&'static str, rpc::Handler)>;      // ex. ("dashboard", handler!(page_dashboard))
```

Le routeur Axum n'a pas d'état (`Router<()>`) : tout passe par les accès globaux
ci-dessus. Syntaxe des chemins Axum 0.8 : `/api/v1/products/{codein}`.

## Actions (ex-« server actions »)

`POST /api/actions/{nom}` — corps : tableau JSON des arguments positionnels,
réponse : la valeur de retour de la fonction TS, sérialisée à l'identique.
Une exception TS (ex. `requireSession()` qui lève) devient une `AppError`
(statut 401/403/500, corps `{ error }`) ; le client la relève en `Error`.

Une action s'écrit :

```rust
async fn get_users(ctx: Ctx) -> AppResult<Value> {
    ctx.admin().await?;                 // = await requireAdmin()
    let page: i64 = ctx.arg(0)?;        // argument n°0 (null si absent → Option<T>)
    …
    json(resultat)
}
```

| Action | Source TS | Module Rust |
|---|---|---|
| `getFournisseurs`, `getMagasins` | `features/grid/actions.ts` | `ff` |
| `getFournisseursPourCadence`, `listCadences`, `upsertCadence`, `toggleCadence`, `removeCadence` | `features/commandes-auto/actions.ts` | `ff` |
| `getUsers`, `createUser`, `deleteUser`, `updatePassword` | `features/admin/api/user-actions.ts` | `admin` |
| `getApiKeys`, `createApiKey`, `revokeApiKey`, `deleteApiKey` | `features/admin/api/api-key-actions.ts` | `admin` |
| `getParametresAffichables`, `testDatabaseConnection`, `saveDatabaseSettings`, `saveQlikSettings`, `testQlikConnection`, `saveFfApiSettings`, `testFfApiConnection` | `features/settings/actions.ts` | `admin` |
| `readSyncSettings`, `saveSyncSettings` | `features/admin/api/sync-settings.ts` | `admin` |
| `getSnapshots`, `deleteSnapshot`, `saveSnapshot` | `features/snapshots/api/*.ts` | `grid` |
| `saveDraftChanges` | `features/grid/api/save-draft-changes.ts` | `grid` |
| `getGammesAValider`, `rejeterGammesAValider` | `features/grid/api/gammes-a-valider-actions.ts` | `grid` |

(`loginAction` disparaît : `POST /api/auth/login`.)

## Pages (données des anciennes pages serveur)

`GET /api/pages/{nom}?…` renvoie **uniquement les données** que la page serveur
obtenait de ses appels d'accès aux données (fonctions `pg*`, API FF, actions),
sous la forme exacte de leur valeur de retour TS. Toute la mise en forme pure
(pivots, listes de mois, totaux…) reste côté interface. En cas d'échec là où la
page affichait un `ErrorState` : statut 500 `{ error: message }`.

| Page | Paramètres | Réponse | Module |
|---|---|---|---|
| `dashboard` | — | `pgGetDashboardData()` (cache 30 min) | `ff` |
| `analytics` | `mode` (`fournisseur`\|`nomenclature`), `mois`, `moisN1` | lignes de `pgGetCaByFournisseur` ou `pgGetCaByNomenclature` (cachedFF, mêmes clés) | `ff` |
| `hit-parade` | `debut`, `fin` | lignes de `pgGetHitParade` (cachedFF) | `ff` |
| `stock-negatif` | `magasin` | `{ rowsNegatif, rowsSansVente, rowsSansVente6Mois }` (cachedFF) | `ff` |
| `commandes-auto` | — | `{ rows, cadences, fournisseurs }` | `ff` |
| `publicites` | `statut`, `page` | `{ publicites, total, pages, erreurPublicites?, historique, erreurHistorique?, pageSize }` | `ff` |
| `produit-fiche` | `codein` ou `cc` | `getProduitFiche(codein)` / `getProduitFicheByCodeCentrale(cc)` (ou `null`) | `produits` |

## Routes HTTP conservées (mêmes chemins, mêmes réponses)

`/api/ff-status`, `/api/diag`, `/api/diag/stock-fournisseur`, `/api/test-db`,
`/api/commandes-auto` → `ff` ; `/api/qlik/sync` → `qlik` ;
`/api/grid/rows`, `/api/grid/rows/store-patch`, `/api/export/excel`,
`/api/export/modified-gammes`, `/api/v1/*` → `grid` ;
`/api/produits/search`, `/api/produits/opportunites` → `produits` ;
`/api/admin/sync`, `/api/admin/sync/fournisseurs`, `/api/admin/grid-warmup`,
`/api/logs` → `admin`. Authentification : `/api/auth/{login,logout,session}`.

## Règles de traduction

- **Formes JSON identiques** : noms de champs exacts (`#[serde(rename_all = "camelCase")]`
  ou `rename` explicite selon l'interface TS), champs optionnels TS absents ⇒
  `#[serde(skip_serializing_if = "Option::is_none")]` (JSON.stringify omet `undefined`,
  mais garde `null`). Une `Map` TS renvoyée au client se sérialise comme le faisait le TS
  (souvent `Object.fromEntries`).
- **Même SQL** : recopier les requêtes telles quelles (paramètres `$1…`, `QueryBuilder`
  ou `format!` contrôlé pour les fragments dynamiques — jamais de valeur utilisateur
  interpolée sans échappement). Les colonnes `numeric` se lisent avec `db::get_f64`.
- **Même tolérance aux pannes** : une fonction TS qui avale l'erreur et rend `[]`
  fait de même ; une qui lève propage une erreur.
- **Journaux** : `tracing::info!/warn!/error!` avec les mêmes préfixes (`[pg-ff]`, `[qlik]`…).
- **Dates** : le conteneur tourne en UTC ; `new Date()` ⇒ `chrono::Local::now()`.
- **Commentaires** en français, comme le code d'origine : garder les « pourquoi ».
- `cargo build` sans avertissement dans son module ; `cargo test` pour la logique pure.
