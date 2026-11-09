#!/usr/bin/env bash
# Serviço "servers" do Codespace: espera a compilação feita pelo setup.sh e
# mantém a API e o site no ar (o Docker reinicia se algo cair).
set -uo pipefail
cd "$(dirname "$0")/.."
until [ -f apps/api/dist/main.js ] && [ -f apps/web/.next/BUILD_ID ] && [ -f .env ]; do
  echo "Esperando a preparação (setup.sh) terminar…"; sleep 10
done
set -a; . ./.env; set +a
mkdir -p .logs
node apps/api/dist/main.js >> .logs/api.log 2>&1 &
API=$!
cd apps/web && npx next start -p 3000 >> ../../.logs/web.log 2>&1 &
WEB=$!
# Se um dos dois cair, encerra o serviço para o Docker reiniciar ambos.
wait -n "$API" "$WEB"
kill "$API" "$WEB" 2>/dev/null
exit 1
