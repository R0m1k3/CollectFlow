# CollectFlow

CollectFlow est une application de révision d'assortiment et d'analyse de performances des produits en point de vente, conçue pour consolider les données issues de plusieurs fournisseurs et magasins.

## Architecture

| Partie | Technologie | Dossier |
|---|---|---|
| Serveur (API, base, FF Nancy, Qlik, synchro nocturne) | **Rust** — Axum, sqlx, chromiumoxide | `server/` |
| Interface | React 19 + Tailwind 4, compilée en fichiers statiques par Vite | `src/` |

Un seul binaire Rust sert l'API JSON (`/api/...`, dont l'API publique `/api/v1`) et l'interface compilée. Plus de Node.js à l'exécution.

## Prérequis

- **Docker** et **Docker Compose** (déploiement)
- **PostgreSQL** 16+ (base séparée, non fournie par le conteneur)
- Pour développer : **Rust** stable (`rustup`) et **Node.js** 22+

## Lancer avec Docker

L'image est construite par GitHub Actions à chaque mise à jour de `main` et publiée sur `ghcr.io/r0m1k3/collectflow:latest`. Le `docker-compose.yml` la récupère à chaque démarrage (`pull_policy: always`) : **une nouvelle version s'installe au prochain `docker compose up -d`**, sans rien compiler sur le serveur.

```bash
# Une seule fois, si le paquet GHCR est privé (jeton GitHub avec le droit read:packages) :
echo <JETON> | docker login ghcr.io -u <utilisateur-github> --password-stdin

# Démarrer / mettre à jour :
docker compose up -d
```

L'application est accessible sur [http://localhost:5643](http://localhost:5643). Elle est attachée au réseau Docker externe `nginx_default` pour être exposée derrière le reverse proxy Nginx (`docker network create nginx_default` s'il n'existe pas).

Construire l'image localement plutôt que la télécharger : `docker compose build`.

### Données et réglages

Le volume `collectflow-data` (`/app/data`) conserve les réglages saisis dans **Paramètres** (`.db-config.json` : base, Qlik, API FF, synchro nocturne), les comptes de secours (`users.json`) et le secret de session (`.auth-secret`, si `AUTH_SECRET` n'est pas défini). Il est repris tel quel depuis l'ancienne version Node : comptes et mots de passe restent valables (seules les sessions ouvertes sont à refaire).

Variables d'environnement utiles : `DATABASE_URL`, `AUTH_SECRET`, `FF_API_BASE_URL`, `QLIK_HOST` / `QLIK_USER` / `QLIK_PWD` (et les réglages fins `QLIK_*`), `PG_STATEMENT_TIMEOUT_MS`, `FF_CACHE_TTL_S`, `RUST_LOG` (niveau de journalisation ; par défaut `info`, avec sqlx et Chromium limités aux avertissements).

## Développement local

```bash
# Serveur (port 5643) — tables créées et compte admin/admin initialisé au premier démarrage
cd server
DATABASE_URL=postgres://postgres:postgres@localhost/collectflow cargo run

# Interface (port 5173, /api relayé vers le serveur)
npm install
npm run dev
```

Vérifications : `cargo test` (dans `server/`), `npm run lint`, `npm run build`.

## Structure

- `server/src/` — serveur Rust, un module par domaine : `auth` (sessions, clés d'API), `ff` (base miroir et API FF Nancy), `qlik` (données réseau), `grid` (révision d'assortiment, API `/api/v1`), `produits`, `admin` (comptes, paramètres, synchronisation nocturne).
- `server/sql/init.sql` — schéma joué (idempotent) à chaque démarrage.
- `src/` — interface React : `features/*` par domaine, `components/` partagés, `pages/` et `router.tsx`.
- `server/PORTING.md` — contrat entre l'interface et le serveur (actions, données de pages, routes).
