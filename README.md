# SitedoPai — Plataforma SaaS de APR e Permissão de Trabalho

Plataforma web multiempresa para gestão de Análise Preliminar de Riscos (APR)
e Permissão de Trabalho (PT), destinada a empresas brasileiras.

> Princípio fundamental: a segurança dos trabalhadores tem prioridade sobre a
> velocidade de preenchimento e liberação.

**Situação:** Fase 1 (Fundação) e Fase 2 (APR: backend e telas no celular)
implementadas e testadas localmente. Não está pronto para produção (ver
*Pendências*).

## Documentos

- [Especificação original](docs/ESPECIFICACAO.md)
- [Modelo de dados](docs/modelo-de-dados.md)
- [ADR 0001 — Kysely no lugar do Prisma](docs/adr/0001-kysely-em-vez-de-prisma.md)
- Proposta de arquitetura, fases e decisões: https://claude.ai/artifact/TP6hHBv9fiNZNy9Bf7tro1
- Matriz de conformidade normativa (preliminar): https://claude.ai/artifact/6gjAZ7DyRWVSoAkHqXEMs5

## Estrutura

```
apps/web          Site Next.js (mobile-first): login OIDC, lista e editor de APR
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
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @sitedopai/web dev                       # site em http://localhost:3000
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
| `packages/db/test/apr-triggers.test.ts` | 7 | Travas da APR no banco: publicação com revisor e validação profissional, imutabilidade de modelo, matriz e APR aprovada, limite e preservação de fotos, numeração |
| `apps/api/test/apr.test.ts` | 38 | Matriz, ciclo do modelo (revisão por outra pessoa), preenchimento, "Sim" que não é seguro, pergunta crítica com nova avaliação, fotos (arquivo disfarçado, imagem corrompida, HEIC, EXIF/GPS removido, original íntegro, limite com envios simultâneos), análise de riscos, envio, aprovação, devolução, cancelamento, revisão, histórico |
| `apps/api/test/cross-tenant.test.ts` | 43 | Lê a lista real de rotas da API (45) e tenta ler, alterar e criar dados da empresa B como administrador e como SST da A. Rota nova sem caso de teste faz a suíte falhar |

### Testes de ponta a ponta (site)

```bash
pnpm build                                  # API e site compilados
cd apps/web && npx playwright test          # usa o Chrome instalado (CHROME_PATH)
```

`apps/web/e2e/apr.spec.ts` (9 cenários, tela de Pixel 7): login obrigatório;
criação da APR; perguntas uma abaixo da outra com botões de no mínimo 48 px;
N/A bloqueado onde não é permitido; acessibilidade WCAG 2.2 AA com axe; fotos
(envio, miniatura, remoção, arquivo falso recusado); pergunta crítica bloqueando
até a nova avaliação por outra pessoa; "Sim" que não é seguro; análise de riscos
com classificação na tela; envio; aprovação pelo supervisor; APR travada. O
login é simulado com tokens assinados por chave de teste (sem Keycloak).

Telas capturadas no teste: [checklist](docs/telas/1-checklist.png) ·
[pergunta crítica](docs/telas/2-pergunta-critica.png) · [riscos](docs/telas/3-riscos.png) ·
[pendências](docs/telas/4-pendencias.png) · [lista](docs/telas/5-lista.png)

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

## APR (Fase 2a)

| Rota | O que faz |
| --- | --- |
| `GET/POST /risk-matrices`, `POST /risk-matrices/:id/publish` | Matriz de risco da empresa (SST) |
| `GET/POST /apr-templates`, `POST /apr-templates/:id/versions` | Modelos e novas versões |
| `GET /apr-template-versions/:id`, `PUT …/questions`, `POST …/submit`, `POST …/review` | Perguntas, envio para revisão, publicação ou devolução |
| `GET/POST /hazard-library` | Biblioteca de perigos |
| `GET/POST /aprs`, `GET/PATCH /aprs/:id` | Lista (por escopo), criação, leitura completa, cabeçalho (com `rowVersion`) |
| `PUT /aprs/:id/answers/:questionId`, `POST …/reassess` | Resposta (com `version`) e nova avaliação |
| `PUT /aprs/:id/analysis` | Etapas, perigos e controles (com `analysisVersion`) |
| `GET /aprs/:id/check` | Pendências, avisos e progresso |
| `POST /aprs/:id/submit · approve · return · cancel · revise` | Fluxo |
| `GET /aprs/:id/history` | Histórico da APR (da trilha de auditoria) |
| `POST /aprs/:id/questions/:questionId/photos`, `GET/DELETE /aprs/:id/photos/:photoId`, `GET …/original` | Fotos |

Edições simultâneas: cada parte da APR tem a própria versão (cabeçalho, cada
resposta, análise). Quem salvar com versão desatualizada recebe 409 e recarrega,
sem sobrescrever o trabalho do outro.

Fotos: aceitas JPEG, PNG e WebP até 15 MB. O tipo é conferido pelo conteúdo do
arquivo; a imagem é decodificada de verdade (arquivo disfarçado é recusado); a
cópia de exibição é reduzida a 1600 px e regravada sem EXIF/GPS; o original fica
intacto, com SHA-256, para prova. HEIC ainda não é aceito (a tela vai converter).

## Pendências

- Decisão 7: indicar profissional de SST e assessoria jurídica.
- Validar `docker-compose.yml` e o realm do Keycloak na sua máquina,
  inclusive se o claim `amr` chega no token com o segundo fator.
- Limite de taxa está em memória; em produção, usar Redis.
- Login real pelo Keycloak no site ainda não foi testado (só com token simulado).
- Sem modo offline: sem sinal, o que foi digitado fica na tela e o salvamento
  pode ser repetido, mas não há fila local (planejado para fase futura).
- CSP do site ainda usa `'unsafe-inline'` para scripts; trocar por nonce na
  implantação.
- Antivírus (ClamAV) para anexos: hoje toda foto fica com `scan_status = PENDING`;
  a decodificação e a regravação já barram arquivos que não são imagem.
- Nenhum modelo vem como "aprovado": o seed traz matriz e modelo de EXEMPLO em
  rascunho, que o SST da empresa precisa revisar e publicar.
- Matriz de conformidade ainda preliminar (textos oficiais a conferir).
