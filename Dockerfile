# CollectFlow — image de production.
#
# 1. web    : compile l'interface React (Vite) en fichiers statiques.
# 2. server : compile le serveur Rust (binaire unique, optimisé).
# 3. runner : Debian minimale + Chromium (extraction Qlik) + les deux livrables.
#
# L'image est construite et publiée par GitHub Actions à chaque push sur main
# (ghcr.io/r0m1k3/collectflow:latest) ; docker-compose la tire au démarrage.

# ---------------------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS server
WORKDIR /build
# Dépendances d'abord : couche réutilisée tant que Cargo.lock ne change pas.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/deps/collectflow* target/release/collectflow*
COPY server/ ./
RUN cargo build --release --locked && cp target/release/collectflow /collectflow

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runner
WORKDIR /app

# Chromium pour l'extraction Qlik (websocket Engine ouvert dans la page) + polices.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-freefont-ttf tzdata \
    && rm -rf /var/lib/apt/lists/*

# Même UID/GID que l'ancienne image Node : le volume /app/data existant reste lisible.
RUN groupadd --system --gid 1001 collectflow \
    && useradd --system --uid 1001 --gid collectflow --home-dir /app collectflow \
    && mkdir -p /app/data \
    && chown -R collectflow:collectflow /app

COPY --from=server /collectflow /app/collectflow
COPY --from=web --chown=collectflow:collectflow /app/dist /app/web

ENV PORT=5643 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/web \
    PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
    RUST_LOG=info

USER collectflow
EXPOSE 5643
VOLUME ["/app/data"]

CMD ["/app/collectflow"]
