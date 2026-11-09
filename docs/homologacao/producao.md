# Lista para produção

Nada aqui foi feito em produção. Marque com a evidência (link, data, responsável).

## Infraestrutura
- [ ] PostgreSQL gerenciado com réplica, backup diário e retenção definida
- [ ] Teste de restauração agendado (`scripts/backup-restore-test.sh`) com alerta
- [ ] Bucket S3 privado, criptografado, com versionamento e Object Lock (compliance)
- [ ] Keycloak em produção: MFA obrigatório para perfis privilegiados, política
      de senha, claim `amr` conferido
- [ ] Redis para limite de requisições
- [ ] Domínio, TLS, HSTS; `PUBLIC_VERIFY_BASE_URL` com o domínio final
- [ ] Segredos em cofre (banco, webhook, chaves); nenhum valor padrão
- [ ] Logs centralizados, métricas e alertas (erros 5xx, latência, fila de PDF)
- [ ] Geração de PDF fora do processo da API (fila)

## Configuração
- [ ] `NODE_ENV=production`, `AUTH_MODE=oidc` (a API recusa `dev` em produção)
- [ ] Provedor de pagamento real (a API recusa o simulado em produção)
- [ ] CORS apenas com o domínio do site
- [ ] Planos e tolerâncias cadastrados

## Validações
- [ ] Teste de intrusão independente, com correções retestadas
- [ ] PDF/A validado com veraPDF
- [ ] Roteiro de SST aprovado
- [ ] Questões jurídicas respondidas e configuradas (guarda, termos, LGPD)
- [ ] Piloto concluído com critérios de saída atendidos
- [ ] CI verde na versão a publicar
