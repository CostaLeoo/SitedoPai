#!/usr/bin/env bash
# Roda uma vez, quando o Codespace é criado: instala, prepara o banco com dados
# fictícios (modo demonstração) e compila API e site.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> Instalando pnpm e dependências…"
sudo npm install -g pnpm@10 >/dev/null
pnpm install --frozen-lockfile

echo "==> Configuração de demonstração…"
[ -f .env ] || cp .env.example .env
cat > apps/web/.env.local <<ENV
# Codespaces: o navegador fala só com o site, que repassa /api para a API.
NEXT_PUBLIC_API_URL=/api
API_PROXY_TARGET=http://localhost:3001
NEXT_PUBLIC_OIDC_AUTHORITY=http://localhost:8080/realms/sitedopai
NEXT_PUBLIC_OIDC_CLIENT_ID=sitedopai-web
NEXT_PUBLIC_AUTH_MODE=dev
ENV

echo "==> Esperando o banco…"
for i in $(seq 1 60); do
  node -e "require('net').connect(5432,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && break
  sleep 2
done
sleep 3
pnpm demo:setup

echo "==> Compilando API e site (1 a 3 minutos)…"
pnpm build
echo "==> Pronto. O site abre sozinho na porta 3000."
