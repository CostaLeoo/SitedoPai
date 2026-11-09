#!/usr/bin/env bash
# Uso manual, só se o site não estiver no ar: sobe a API e o site em segundo plano.
# Normalmente o serviço "servers" (run-servers.sh) já faz isso sozinho.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f apps/api/dist/main.js ] || { echo "Ainda compilando (setup)…"; exit 0; }
set -a; . ./.env; set +a
if [ -n "${CODESPACE_NAME:-}" ]; then
  export PUBLIC_VERIFY_BASE_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi
mkdir -p .logs
pgrep -f "apps/api/dist/main.js" >/dev/null || setsid nohup node apps/api/dist/main.js > .logs/api.log 2>&1 < /dev/null &
pgrep -f "next start" >/dev/null || (cd apps/web && setsid nohup npx next start -p 3000 > ../../.logs/web.log 2>&1 < /dev/null &)
echo "SitedoPai rodando: abra a aba PORTS e clique no globo da porta 3000."
