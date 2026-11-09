# SitedoPai — Plataforma SaaS de APR e Permissão de Trabalho

Plataforma web multiempresa para gestão de Análise Preliminar de Riscos (APR)
e Permissão de Trabalho (PT), destinada a empresas brasileiras.

> Princípio fundamental: a segurança dos trabalhadores tem prioridade sobre a
> velocidade de preenchimento e liberação.

**Situação:** Fase 1 (Fundação) implementada e testada localmente. Não está
pronto para produção (ver *Pendências*).

## Documentos

- [Especificação original](docs/ESPECIFICACAO.md)
- [Modelo de dados](docs/modelo-de-dados.md)
- [ADR 0001 — Kysely no lugar do Prisma](docs/adr/0001-kysely-em-vez-de-prisma.md)
- Proposta de arquitetura, fases e decisões: https://claude.ai/artifact/TP6hHBv9fiNZNy9Bf7tro1
- Matriz de conformidade normativa (preliminar): https://claude.ai/artifact/6gjAZ7DyRWVSoAkHqXEMs5

## Estrutura

```
apps/api          API NestJS (autenticação OIDC, empresa ativa, permissões, rotas)
packages/db       Migrações SQL, tipos Kysely, contexto RLS, auditoria, seed
infra/keycloak    Realm de desenvolvimento do Keycloak
scripts           Criação do banco e dos papéis
docs              Especificação, modelo de dados, decisões (ADRs)
```

## Como rodar localmente

Requisitos: Node 22, pnpm 10, Docker (ou um PostgreSQL 16 local).

```bash
pnpm install
cp .env.example .env
docker compose up -d                                   # Postgres, Redis, MinIO, Keycloak
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres pnpm db:setup   # banco + papéis
pnpm db:migrate                                        # aplica migrations/*.sql
pnpm db:seed                                           # dados fictícios de demonstração
pnpm dev                                               # API em http://localhost:3001
```

Usuários de demonstração no Keycloak (http://localhost:8080, realm `sitedopai`):
`admin@`, `sst@`, `supervisor@`, `executante@` e `plataforma@sitedopai.local`,
senha inicial `Troque-esta-senha-1` (o Keycloak pede a troca e, para perfis
privilegiados, o cadastro do segundo fator).

> O `docker-compose.yml` e o realm do Keycloak não foram executados no ambiente
> em que esta fase foi construída (sem Docker). Banco, migrações, seed e API
> foram testados com PostgreSQL 16 local.

## Testes

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash scripts/setup-db.sh sitedopai_test
pnpm test
```

| Suíte | Testes | O que cobre |
| --- | --- | --- |
| `packages/db/test/rls.test.ts` | 21 | RLS em todas as tabelas, chaves compostas, papel sem `BYPASSRLS`, funções privilegiadas, auditoria somente inserção, 30 gravações concorrentes, detecção de adulteração |
| `apps/api/test/api.test.ts` | 38 | Tokens inválidos (assinatura, validade, emissor, público, `alg: none`), convite, MFA por perfil, permissões e escopo por unidade, empresa somente leitura, concorrência (409), área da plataforma |
| `apps/api/test/cross-tenant.test.ts` | 13 | Lê a lista real de rotas da API e tenta ler, alterar e criar dados da empresa B como administrador da A. Rota nova sem caso de teste faz a suíte falhar |

## Segurança implementada na Fase 1

- Isolamento em cinco camadas: chaves compostas, RLS com `FORCE`, empresa ativa
  validada contra vínculo no banco, papel de banco sem `BYPASSRLS`, contexto por
  transação. Recurso de outra empresa responde 404.
- Autenticação delegada ao provedor OIDC (Keycloak): a API só valida tokens
  (assinatura, emissor, público, validade, algoritmos permitidos).
- MFA obrigatório (claim `amr`) para administrador, SST, supervisor, auditor e
  administrador da plataforma.
- Convite por e-mail: só é vinculado no primeiro login com e-mail verificado.
- Administrador da plataforma sem acesso a dados de clientes.
- Trilha de auditoria encadeada por hash, somente inserção, com verificação.
- Entradas validadas com esquemas estritos (campos desconhecidos são recusados);
  erros sem detalhes internos; Helmet; limite de corpo e de taxa.
- Empresa em modo somente leitura (inadimplência ou encerramento) mantém
  consulta e bloqueia escrita, sem apagar nada.

## Pendências

- Decisão 7: indicar profissional de SST e assessoria jurídica.
- Validar `docker-compose.yml` e o realm do Keycloak na sua máquina,
  inclusive se o claim `amr` chega no token com o segundo fator.
- Limite de taxa está em memória; em produção, usar Redis.
- Sem frontend ainda: entra junto com a APR, na Fase 2.
- Matriz de conformidade ainda preliminar (textos oficiais a conferir).
