# Master Plan - Résolution Dashboard 502

## Contexte
Le dashboard affiche une erreur 502 Bad Gateway. L'API `api.ffnancy.fr` semble fonctionner de l'extérieur, mais la connexion interne depuis le conteneur Next.js échoue, probablement à cause d'URL codées en dur qui ne respectent pas les variables d'environnement.

## Focus Actuel
Harmonisation des URL API dans le code source pour utiliser `FF_API_BASE_URL`.

## Master Plan
- [x] Analyser tous les appels API dans `pg-ff-client.ts` et `api-ff-client.ts`
- [x] Centraliser la constante `FF_API_BASE` dans `pg-ff-client.ts`
- [x] Remplacer les URL codées en dur par `${FF_API_BASE}`
- [x] Vérifier la configuration Docker et les variables d'environnement

- [x] Tester via `/api/diag` (Implémentation validée)


## Progress Log
- Analyse initiale terminée : identification d'une URL codée en dur à la ligne 564 de `pg-ff-client.ts`.
- Harmonisation effectuée dans `pg-ff-client.ts`.
- Vérification des autres fichiers `src` effectuée : tous utilisent désormais `FF_API_BASE`.
