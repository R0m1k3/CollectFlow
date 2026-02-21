# CollectFlow

CollectFlow est une application de révision d'assortiment et d'analyse de performances des produits en point de vente, conçue pour consolider les données issues de plusieurs fournisseurs et magasins.

## Prérequis

- **Node.js** 18+ (pour le développement local)
- **Docker** et **Docker Compose** (pour le déploiement conteneurisé)
- **PostgreSQL** 16+

## Lancer avec Docker

Le projet est configuré pour tourner dans un conteneur Docker optimisé (mode standalone de Next.js).
**Note :** Vous devez disposer d'une base de données PostgreSQL séparée (le conteneur ne lance que l'application web).

### 1. Démarrer l'application
À la racine du projet, lancez :
```bash
npm run docker:build
# ou directement
docker-compose up -d --build
```
L'application sera accessible sur [http://localhost:5643](http://localhost:5643).

*L'application sera attachée au réseau Docker externe `nginx_default` afin d'être exposée derrière votre reverse proxy Nginx. Assurez-vous que ce réseau existe (`docker network create nginx_default`).*

### 2. Arrêter l'application
```bash
npm run docker:down
# ou directement
docker-compose down
```

## Développement Local (Sans Docker)

Si vous préférez développer en local, vous devrez configurer votre propre base de données PostgreSQL.

1. Installer les dépendances :
```bash
npm install
```

2. Configurer la connexion DB :
Allez sur la page des Paramètres (`/settings`) dans l'application pour configurer l'accès à votre PostgreSQL local.

3. Lancer le serveur de développement :
```bash
npm run dev
```

## Structure du Projet (BMAD)

Ce projet respecte l'architecture **BMAD** (Business, Model, Application/API, Data) :
- `src/features/*` : Logique métier (Business) isolée par feature (ex: `grid`, `snapshots`)
- `src/types/*` : Interfaces TypeScript (Model)
- `src/app/*` : Routeurs Next.js UI et endpoints d'API (Application/API)
- `src/db/*` : Schémas Drizzle ORM et connexions (Data)
