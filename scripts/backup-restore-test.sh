#!/usr/bin/env bash
# Teste de backup e restauração (exigido pela especificação: "testes periódicos
# de restauração"). Faz o dump, restaura num banco novo e confere:
#   1. mesma quantidade de linhas em todas as tabelas;
#   2. cadeia de hashes da auditoria íntegra em todas as empresas (audit_verify);
#   3. (opcional) hash SHA-256 de cada PDF emitido e de cada foto original no
#      armazenamento, comparado com o registrado no banco.
#
# Uso:
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=... \
#   BACKUP_URL=postgresql://sitedopai_backup:...@localhost:5432/sitedopai \
#   [STORAGE_DIR=./apps/api/.storage] [KEEP=1] bash scripts/backup-restore-test.sh [banco_origem]
#
# PGUSER precisa poder criar banco (o restaurado é apagado no fim, salvo KEEP=1).
set -euo pipefail
SRC="${1:-sitedopai}"
BACKUP_URL="${BACKUP_URL:-postgresql://sitedopai_backup:dev_backup_pw@${PGHOST:-localhost}:5432/${SRC}}"
DST="${SRC}_restore_$(date +%Y%m%d%H%M%S)"
DUMP="$(mktemp -d)/sitedopai.dump"
PSQL="${PSQL:-psql}"
fail() { echo "FALHOU: $*" >&2; exit 1; }

echo "1/5 Dump de ${SRC} com o papel de backup…"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$BACKUP_URL"
echo "    $(du -h "$DUMP" | cut -f1) · SHA-256 $(sha256sum "$DUMP" | cut -c1-16)…"

echo "2/5 Restaurando em ${DST}…"
$PSQL -v ON_ERROR_STOP=1 -qd postgres -c "CREATE DATABASE \"${DST}\""
cleanup() { [ "${KEEP:-0}" = 1 ] || $PSQL -qd postgres -c "DROP DATABASE IF EXISTS \"${DST}\" WITH (FORCE)" >/dev/null; }
trap cleanup EXIT
pg_restore --exit-on-error --no-owner --no-privileges -d "$DST" "$DUMP"

echo "3/5 Comparando a quantidade de linhas por tabela…"
count_all() {
  $PSQL -tAd "$1" -c "SET row_security = off;" -c "
    SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
      SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, true, '')))[1]::text::bigint AS n
        FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname = 'public' AND c.relkind = 'r') x"
}
A="$(count_all "$BACKUP_URL" | tail -1)"
B="$(PGOPTIONS='-c row_security=off' count_all "$DST" | tail -1)"
[ "$A" = "$B" ] || fail "contagens diferentes
origem:     $A
restaurado: $B"
echo "    $(echo "$A" | wc -w) tabelas com contagens idênticas"

echo "4/5 Verificando a cadeia de hashes da auditoria de cada empresa…"
for t in $($PSQL -tAd "$DST" -c "SELECT id FROM tenants ORDER BY created_at"); do
  # audit_verify() devolve NULL se a cadeia está íntegra, ou o nº do primeiro evento inválido.
  broken=$($PSQL -tAd "$DST" -v ON_ERROR_STOP=1 -c "SELECT set_config('app.tenant_id', '$t', false)" -c "SELECT COALESCE(audit_verify()::text, '')" | tail -1)
  n=$($PSQL -tAd "$DST" -c "SELECT count(*) FROM audit_events WHERE tenant_id = '$t'")
  [ -z "$broken" ] || fail "auditoria adulterada ou quebrada na empresa $t a partir do evento $broken"
  echo "    empresa $t: $n evento(s), cadeia íntegra"
done

echo "5/5 Conferindo arquivos no armazenamento…"
if [ -n "${STORAGE_DIR:-}" ]; then
  bad=0; total=0
  while IFS='|' read -r key sha; do
    [ -z "$key" ] && continue
    total=$((total + 1))
    got=$(sha256sum "${STORAGE_DIR}/${key}" 2>/dev/null | cut -d' ' -f1 || true)
    [ "$got" = "$sha" ] || { echo "    divergente ou ausente: $key" >&2; bad=$((bad + 1)); }
  done < <($PSQL -tAd "$DST" -c "SELECT storage_key || '|' || sha256 FROM issued_documents UNION ALL SELECT original_key || '|' || sha256 FROM apr_photos")
  [ "$bad" = 0 ] || fail "$bad de $total arquivo(s) com hash divergente ou ausente"
  echo "    $total arquivo(s) íntegros (PDFs emitidos e fotos originais)"
else
  echo "    STORAGE_DIR não informado: arquivos não conferidos (em S3, use versionamento + Object Lock e confira por amostragem)."
fi
echo "OK: backup restaurável e íntegro."
