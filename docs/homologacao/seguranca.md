# Segurança — evidências da Fase 6

## Testes automatizados (rodam no CI a cada envio)

| Suíte | Testes | Cobertura principal |
| --- | --- | --- |
| Banco (`packages/db/test`) | 34 | RLS em todas as tabelas, papel da aplicação sem BYPASSRLS, travas de imutabilidade (APR aprovada, PT, assinaturas, medições, auditoria) |
| API (`apps/api/test`) | 220 | Tokens inválidos, MFA, permissões, escopo por unidade, concorrência, fotos maliciosas, PDF, guarda, cobrança, webhooks, paginação |
| Varredura entre empresas | 92 | Lê a lista real de rotas (109) e tenta ler, alterar e criar dados de outra empresa em todas; rota nova sem teste faz o CI falhar |
| Navegador (`apps/web/e2e`) | 25 | Fluxos completos de APR, PT, PDF, comercial; acessibilidade (axe, WCAG 2 AA); CSP com nonce sem violações; cabeçalhos |

## Dependências (`pnpm audit`)

Em 09/11/2026, antes da Fase 6: 5 altas, 6 moderadas, 1 baixa. Corrigido:

- **sharp 0.34.5 → 0.35.5** (API e site): falhas em libvips, libheif e librsvg.
  É a biblioteca que processa as fotos enviadas, ou seja, arquivo de fora;
  era o risco mais relevante. Os 38 testes de foto (arquivo disfarçado, imagem
  corrompida, HEIC, remoção de EXIF/GPS) passam com a versão nova.
- **postcss** (usado pelo Next na compilação), **glob** e **minimatch** (só
  testes): fixados em versões corrigidas via `overrides`.

Restante: 1 baixa em `deepmerge`, usada só pelo Jest nos testes, sem versão
corrigida publicada. Não vai para produção.

## Correções feitas nesta fase

- **CSP do site com nonce por requisição** (`middleware.ts`): `script-src`
  sem `'unsafe-inline'`, com `'strict-dynamic'`; `object-src 'none'`,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS em produção. Teste de
  navegador confere que não há violação de CSP e que o nonce muda a cada página.
- **Listas sem limite oculto**: APRs e PTs antigas ficavam inacessíveis (só as
  200 mais recentes apareciam). Agora há paginação por cursor, com teste que
  garante não perder nem repetir itens.
- **Índices** para listagens e consultas frequentes (migração 0006).
- **Papel de backup** (`sitedopai_backup`): só leitura, com BYPASSRLS, para o
  `pg_dump` enxergar todas as empresas. Sem ele, o backup feito com o dono do
  schema sairia **vazio** nas tabelas com RLS forçada.

## Backup e restauração

`scripts/backup-restore-test.sh` faz o dump com o papel de backup, restaura num
banco novo e confere: contagem de linhas de todas as tabelas, cadeia de hashes
da auditoria de cada empresa e, com `STORAGE_DIR`, o SHA-256 de cada PDF
emitido e foto original.

Execução em 09/11/2026 (banco de desenvolvimento): 42 tabelas idênticas,
cadeia de auditoria íntegra. **Prova negativa:** um evento de auditoria foi
alterado direto no banco (como superusuário, desligando a trava); o teste
falhou apontando "a partir do evento 2".

A especificação pede testes **periódicos**: agendar no ambiente de produção
(sugestão: semanal, com alerta em caso de falha) e guardar o log.

## Pendências de segurança antes da produção

- Teste de intrusão por empresa independente.
- Limite de requisições em Redis (hoje em memória, por instância).
- Antivírus (ClamAV) para anexos; hoje as fotos são decodificadas e regravadas,
  o que barra arquivos que não são imagem, mas não há varredura.
- Object Lock (modo compliance) no bucket de documentos.
- Validar PDF/A com veraPDF.
- Gestão de segredos (cofre), rotação de chaves e do segredo de webhook.
- Monitoramento, alertas e registro centralizado de logs.
- Login real pelo Keycloak testado de ponta a ponta (hoje com token simulado
  nos testes e login de teste no desenvolvimento).
