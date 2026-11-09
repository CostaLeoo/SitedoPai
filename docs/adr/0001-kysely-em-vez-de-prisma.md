# ADR 0001 — Kysely e migrações em SQL no lugar do Prisma

Data: 09/11/2026 · Situação: aceita (pode ser revista)

## Contexto

A especificação sugeria Prisma. O isolamento entre empresas depende de
Row-Level Security no PostgreSQL, com o contexto da empresa fixado por
transação (`SET LOCAL`). A proposta de arquitetura já previa uma prova de
conceito de Prisma + RLS na Fase 1, com Kysely como alternativa.

Ao iniciar a Fase 1, o Prisma 6 não funcionou no ambiente de desenvolvimento:
ele baixa motores nativos de `binaries.prisma.sh` durante a instalação, e esse
endereço estava bloqueado (só os registros de pacotes estavam liberados).
Ambientes corporativos de clientes e de CI costumam ter o mesmo tipo de
restrição.

## Decisão

- Consultas com **Kysely** (TypeScript puro, tipado, sem binários).
- Migrações em **SQL puro** (`packages/db/migrations/*.sql`), aplicadas por um
  executor próprio que registra versão e checksum e recusa migrações alteradas
  depois de aplicadas.
- Acesso a dados de cliente apenas por `withContext()`, que abre a transação e
  fixa `app.tenant_id` e `app.user_id`.

## Consequências

- RLS, gatilhos e funções `SECURITY DEFINER` ficam no mesmo lugar que o schema,
  revisáveis linha a linha.
- Não há geração automática de migrações: os tipos em `packages/db/src/schema.ts`
  precisam acompanhar o SQL. Os testes de banco cobrem a divergência mais grave
  (consultas a colunas inexistentes falham).
- A imagem de produção fica menor, sem motores nativos.
