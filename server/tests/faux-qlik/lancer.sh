#!/bin/bash
# Lance le faux Qlik (HTTPS :443, il faut donc les droits root) en arrière-plan.
#
#   server/tests/faux-qlik/lancer.sh [NB_CODES=… NB_AUTRES=… DELAI_MS=… MOIS_MANQUANT=YYYY-MM]
#
# puis, depuis server/ :
#   NB_CODES=… cargo test extraction_faux_qlik -- --ignored --nocapture
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
[ -d "$D/node_modules/ws" ] || npm install --prefix "$D" --no-audit --no-fund --silent
[ -f "$D/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/key.pem" -out "$D/cert.pem" -days 30 -subj "/CN=localhost" 2>/dev/null
[ -f "$D/pid" ] && kill "$(cat "$D/pid")" 2>/dev/null || true
sleep 0.5
env "$@" nohup node --max-old-space-size=4096 "$D/serveur.js" > "$D/serveur.log" 2>&1 &
echo $! > "$D/pid"
for _ in $(seq 1 60); do grep -q "écoute" "$D/serveur.log" && break; sleep 0.5; done
cat "$D/serveur.log"
