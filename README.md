# SitedoPai — Plataforma SaaS de APR e Permissão de Trabalho

Plataforma web multiempresa para gestão de Análise Preliminar de Riscos (APR)
e Permissão de Trabalho (PT), destinada a empresas brasileiras.

> Princípio fundamental: a segurança dos trabalhadores tem prioridade sobre a
> velocidade de preenchimento e liberação.

**Situação:** Fase 1 (Fundação), Fase 2 (APR) e Fase 3 (Permissão de
Trabalho), com backend e telas no celular, implementadas e testadas localmente. Não está pronto para produção (ver
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

Requisitos: Node 22, pnpm 10 e Docker (ou um PostgreSQL 16 instalado).

```bash
pnpm install
cp .env.example .env                    # no Windows: copy .env.example .env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d postgres           # só o banco; o Keycloak não é necessário no modo de teste
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres pnpm db:setup
pnpm db:migrate
pnpm db:seed                            # dados fictícios
pnpm dev                                # API em http://localhost:3001
# em outro terminal:
pnpm --filter @sitedopai/web dev        # site em http://localhost:3000
```

### Login de teste (sem Keycloak)

Com `AUTH_MODE=dev` (API) e `NEXT_PUBLIC_AUTH_MODE=dev` (site), já definidos nos
`.env.example`, a tela de entrada mostra a lista de usuários fictícios do seed:
basta escolher um. Não há senha nem verificação em duas etapas; a API emite o
token com uma chave gerada a cada inicialização.

- A API **se recusa a iniciar** com `AUTH_MODE=dev` e `NODE_ENV=production` (teste automatizado).
- Só aceita e-mails `@sitedopai.local`.
- Para usar o Keycloak, troque para `AUTH_MODE=oidc`, remova `NEXT_PUBLIC_AUTH_MODE` e rode `docker compose up -d`.
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
| `packages/db/test/pt-triggers.test.ts` | 6 | Travas da PT no banco: máquina de estados, dados congelados após envio, entradas só em execução e saída sempre, imutabilidade de medições, assinaturas e qualificações, hash do conteúdo assinado |
| `apps/api/test/pt.test.ts` | 21 | Qualificações e trabalhadores, tipo de PT, APR aprovada obrigatória, validade máxima, funções e qualificações da equipe, análise, gases (ausente, fora do limite), liberação (papel, designação, MFA, login recente, segregação), ciência individual, entradas, suspensão automática por gás, retomada, encerramento, verificação de assinaturas, expiração |
| `apps/api/test/cross-tenant.test.ts` | 79 | Lê a lista real de rotas da API (81) e tenta ler, alterar e criar dados da empresa B como administrador e como SST da A. Rota nova sem caso de teste faz a suíte falhar |

### Testes de ponta a ponta (site)

```bash
pnpm build                                  # API e site compilados
cd apps/web && npx playwright test          # usa o Chrome instalado (CHROME_PATH)
```

`apps/web/e2e/pt.spec.ts` (8 cenários): PT a partir de APR aprovada; equipe;
checklist; análise; medições com vírgula decimal; liberação com login antigo
pedindo novo login; ciência de cada integrante; entradas; suspensão automática
por gás com saída ainda permitida; retomada exigindo nova medição; suspensão
pelo vigia; encerramento assinado; verificação das assinaturas; WCAG 2.2 AA.

`apps/web/e2e/apr.spec.ts` (9 cenários, tela de Pixel 7): login obrigatório;
criação da APR; perguntas uma abaixo da outra com botões de no mínimo 48 px;
N/A bloqueado onde não é permitido; acessibilidade WCAG 2.2 AA com axe; fotos
(envio, miniatura, remoção, arquivo falso recusado); pergunta crítica bloqueando
até a nova avaliação por outra pessoa; "Sim" que não é seguro; análise de riscos
com classificação na tela; envio; aprovação pelo supervisor; APR travada. O
login é simulado com tokens assinados por chave de teste (sem Keycloak).

Telas capturadas no teste: [checklist](docs/telas/1-checklist.png) ·
[pergunta crítica](docs/telas/2-pergunta-critica.png) · [riscos](docs/telas/3-riscos.png) ·
[pendências](docs/telas/4-pendencias.png) · [lista](docs/telas/5-lista.png) ·
[PT válida](docs/telas/6-pt-valida.png) · [PT suspensa](docs/telas/7-pt-suspensa.png) ·
[assinaturas da PT](docs/telas/8-pt-assinaturas.png)

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

## Permissão de Trabalho (Fase 3a)

Nenhum valor normativo é fixo no código: validade máxima, parâmetros e limites
de gases, idade máxima da medição, funções obrigatórias, qualificações por
função e designação de quem libera são configurados pelo SST em cada **tipo de
PT**, que só é publicado com revisão de outra pessoa e identificação do
profissional que validou.

| Rota | O que faz |
| --- | --- |
| `GET/POST /workers`, `PATCH /workers/:id` | Trabalhadores |
| `GET/POST /qualification-types`, `GET/POST /workers/:id/qualifications`, `POST /worker-qualifications/:id/revoke` | Qualificações |
| `GET/POST /pt-types`, `PUT /pt-types/:id`, `POST /pt-types/:id/publish` | Tipos de PT |
| `GET/POST /work-permits`, `GET/PATCH /work-permits/:id`, `PUT …/team`, `PUT …/answers/:q`, `POST …/reassess` | Preparação |
| `GET …/check`, `POST …/submit`, `POST …/review` | Verificação e análise |
| `POST …/measurements` | Medição (fora do limite com PT em vigor → suspensão automática) |
| `POST …/release`, `POST …/acknowledge`, `POST …/start` | Liberação assinada, ciência de cada integrante, início |
| `POST …/suspend`, `POST …/resume` | Suspensão (qualquer integrante, sem atrito) e retomada assinada |
| `POST …/entries`, `POST …/entries/:id/exit` | Entradas e saídas |
| `POST …/close`, `POST …/cancel`, `POST …/reject` | Encerramento assinado, cancelamento, rejeição |
| `GET …/validity`, `GET …/signatures`, `GET …/history` | Vale agora?, assinaturas verificadas, histórico |

## Pendências

- Decisão 7: indicar profissional de SST e assessoria jurídica.
- Validar `docker-compose.yml` e o realm do Keycloak na sua máquina,
  inclusive se o claim `amr` chega no token com o segundo fator.
- Limite de taxa está em memória; em produção, usar Redis.
- PT: fotos no checklist da PT; revalidação por turno sem
  mudança de condições (NR-35, item 35.5.8.2) ainda não implementada — hoje
  exige nova PT.
- Decisão pendente: trabalhador **sem conta** não consegue registrar ciência, e
  a PT não inicia. Alternativa (ciência colhida presencialmente e atestada pelo
  supervisor) depende de parecer jurídico.
- Valores de exemplo nos testes (limites de gases, validade) são só dados de
  teste, não recomendação normativa.
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
