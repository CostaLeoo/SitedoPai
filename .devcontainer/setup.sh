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
# Endereço público do site neste Codespace (usado no QR Code dos PDFs).
if [ -n "${CODESPACE_NAME:-}" ]; then
  grep -v '^PUBLIC_VERIFY_BASE_URL=' .env > .env.tmp && mv .env.tmp .env
  echo "PUBLIC_VERIFY_BASE_URL=https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}" >> .env
fi
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
echo "==> Pronto. Em alguns segundos o site fica disponível na porta 3000 (aba PORTS)."
