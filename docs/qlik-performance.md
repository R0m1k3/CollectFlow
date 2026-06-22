# Qlik — Performance & tuning de la sync réseau

Ce document rassemble les variables d'environnement et leviers qui agissent
sur la **vitesse** et la **robustesse** de l'extraction Qlik réseau
(`POST /api/qlik/sync`, routeur `src/app/api/qlik/sync/route.ts`,
extracteur `src/lib/qlik-playwright.ts`, helper de fenêtre
`src/lib/qlik-date-range.ts`).

Toutes ces variables sont **optionnelles** : valeur par défaut sûre.

> ⚠️ Aucune concurrence / parallélisme Qlik n'a été ajouté — chaque sync
> reste **mono-flux** (un seul websocket Engine, une seule fenêtre
> temporelle). Les optimisations ci-dessous n'augmentent pas la charge
> sur le moteur Qlik ; elles **réduisent** la quantité de travail qu'on
> lui demande.

---

## Variables d'environnement

| Nom                         | Type | Défaut | Bornes              | Effet                                                                                  |
| --------------------------- | ---- | ------ | ------------------- | -------------------------------------------------------------------------------------- |
| `QLIK_SYNC_MONTHS_BACK`     | int  | `12`   | `1`..`12`           | Profondeur de la fenêtre temporelle (mois glissants, mois courant exclu). Plus petit = moins de mois scannés = extraction plus rapide. |
| `QLIK_SETTLE_MS`            | int  | `150`  | `0`..`2000`         | Latence (ms) après chaque mutation de sélection (Date / Article Code) avant l'appel RPC suivant. Protège l'Engine contre les collisions qui provoquent `code:15 Request aborted`. |
| `QLIK_CODE15_MAX_ATTEMPTS`  | int  | `4`    | `1`..`8`            | Nombre max de retries sur Engine `code:15` par appel RPC, avec backoff `QLIK_SETTLE_MS * attempt`. |
| `QLIK_ARTICLE_BATCH_SIZE`   | int  | `150`  | `1`..`500`          | Taille du premier lot d'`Article Code` sélectionné par appel `SelectValues`.            |
| `QLIK_ARTICLE_BATCH_FALLBACKS` | CSV | `75,50` | chaque valeur `1`..`500` | Tailles de repli quand un lot déclenche un `code:15`. Valeurs ordonnées croissant appliquées successivement. |

> **Format CSV pour `QLIK_ARTICLE_BATCH_FALLBACKS`** : valeurs séparées par
> des virgules, ex. `QLIK_ARTICLE_BATCH_FALLBACKS=100,75,50,25`. Les doublons
> et valeurs hors bornes sont dédupliqués / clampés automatiquement, puis appliqués dans l'ordre fourni.

---

## Optimisations déjà en place (pattern durable)

Le pipeline reste **mono-connexion** pour ne jamais surcharger le moteur Qlik :

1. **Fenêtre temporelle bornée** : on ne demande jamais à Qlik de scanner
   l'historique complet ; uniquement les `QLIK_SYNC_MONTHS_BACK` derniers
   mois.
2. **Découpe mensuelle** : `getMonthRanges()` produit 1 sous-fenêtre par mois
   calendaire. Chaque cube reste ainsi borné à ~28–31 jours × N codes.
3. **Hypercube session object JETABLE** : `fetchCubeForSelection()` crée un
   `CreateSessionObject` neuf par lot, lit ses pages, puis appelle
   `DestroySessionObject`. C'est ce qui a éliminé les `code:15 Request aborted`
   à grande échelle (la réutilisation du même objet sur des centaines de
   recalculs forçait l'Engine à recalculer en boucle).
4. **Fallbacks code 15** : si un lot trop large déclenche un `code:15`, on
   retente automatiquement avec une taille plus petite (cf.
   `QLIK_ARTICLE_BATCH_FALLBACKS`) sans tout annuler.

## Nouveautés (cette itération)

1. **Fenêtre paramétrable `QLIK_SYNC_MONTHS_BACK`** (1..12, défaut 12). Permet
   de scoper un sync test à 6 mois au lieu de 12, ou de n'extraire que les 3
   derniers mois pour un check rapide. Le helper `envMonthsBack()` (dans
   `src/lib/qlik-date-range.ts`) clamp la valeur et applique le défaut si
   l'env est mal configurée.
2. **Filtre strict des codes centraux** dans `route.ts` (regex `[A-Z0-9][A-Z0-9_-]{1,29}`,
   longueur 2..30, exclusion de `""`, `"-"`, `"_"`). Réduit les erreurs Engine
   sur des valeurs parasites et le gaspillage réseau. Le log expose le **nombre**
   de codes rejetés mais pas les valeurs (hygiène logs).
3. **Résumé timing final** : ligne unique `[qlik-pw][summary] rows=… months=…
   batches=… code15Retries=… fallbackCount=… totalMs=…` émise en fin de sync
   pour audit/debug sans avoir à parser les logs détaillés par lot.

## Exemple de `.env.local`

```env
# Sync Qlik : fenêtre par défaut 12 mois ; on peut descendre à 6 pour un
# test rapide ou un check hebdo sans recharger tout l'historique.
QLIK_SYNC_MONTHS_BACK=12

# Batch sizes / fallbacks (laisser par défaut sauf contre-indication).
QLIK_ARTICLE_BATCH_SIZE=150
QLIK_ARTICLE_BATCH_FALLBACKS=75,50
QLIK_SETTLE_MS=150
QLIK_CODE15_MAX_ATTEMPTS=4
```

## Tests

```bash
# Tests purs Node (aucune dépendance Next.js).
npx tsx scripts/test-qlik-date-range.ts
```

Couvre :
- repères Qlik (sérial ↔ ISO),
- fenêtre 12 mois (référence),
- `getMonthRanges()` : 12 mois / fenêtre partielle / année bissextile,
- option `monthsBack` : 6 mois + clamp 0 / -5 / 24 / NaN / undefined,
- helper `envMonthsBack()` : env absent / vide / valide / hors bornes /
  non numérique / décimal / espaces.

## Référence

- `src/lib/qlik-date-range.ts` — fenêtre, `envMonthsBack`, `getMonthRanges`.
- `src/lib/qlik-playwright.ts` — extracteur Playwright, hypercube jetable,
  fallbacks code 15, `[qlik-pw][summary]` final.
- `src/app/api/qlik/sync/route.ts` — route admin, `filterCentralCodes`,
  applique `QLIK_SYNC_MONTHS_BACK` via `envMonthsBack`.
- `scripts/test-qlik-date-range.ts` — tests CLI.
- `docs/qlik-integration.md` — doc d'intégration générale (auth NTLM,
  discovery, hypercube, etc.).
