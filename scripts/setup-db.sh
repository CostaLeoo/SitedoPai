#!/usr/bin/env bash
# Cria o banco e os dois papéis usados pelo SitedoPai em um Postgres de desenvolvimento.
#   sitedopai_owner: dono do schema, usado só pelas migrações.
#   sitedopai_app:   usado pela API; sem BYPASSRLS, sem ser dono das tabelas.
# Uso: PGHOST=localhost PGUSER=postgres bash scripts/setup-db.sh [nome_do_banco]
set -euo pipefail
DB="${1:-sitedopai}"
OWNER_PW="${OWNER_PW:-dev_owner_pw}"
APP_PW="${APP_PW:-dev_app_pw}"
PSQL="${PSQL:-psql}"

$PSQL -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitedopai_owner') THEN
    CREATE ROLE sitedopai_owner LOGIN PASSWORD '${OWNER_PW}' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitedopai_app') THEN
    CREATE ROLE sitedopai_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;
END
\$\$;
SQL

if ! $PSQL -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB}'" | grep -q 1; then
  $PSQL -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"${DB}\" OWNER sitedopai_owner"
fi
$PSQL -v ON_ERROR_STOP=1 -d "${DB}" -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO sitedopai_owner; GRANT USAGE ON SCHEMA public TO sitedopai_app;"
echo "Banco ${DB} pronto."
