# Homologação (Fase 6)

> **O sistema NÃO está pronto para produção.** Esta pasta reúne as evidências
> técnicas já produzidas e o que ainda depende de pessoas: profissional de SST,
> assessoria jurídica e empresas piloto.

## Situação por item da especificação

| Item | Situação | Evidência / próximo passo |
| --- | --- | --- |
| Testes de segurança automatizados | Feito | [seguranca.md](seguranca.md): banco 34, API 220, navegador 25 testes; auditoria de dependências |
| Teste de intrusão por terceiro | **Pendente** | Contratar empresa independente antes da produção |
| Testes de carga | Feito (local) | [carga.md](carga.md) e [carga-resultado.md](carga-resultado.md) |
| Teste de carga no ambiente de produção | **Pendente** | Repetir com a infraestrutura definitiva |
| Backup e restauração | Feito (local) | `scripts/backup-restore-test.sh`, ver [seguranca.md](seguranca.md#backup-e-restauração) |
| Validação com profissionais de SST | **Pendente (decisão 7)** | Roteiro em [roteiro-sst.md](roteiro-sst.md) |
| Revisão jurídica | **Pendente (decisão 7)** | Perguntas em [questoes-juridicas.md](questoes-juridicas.md) |
| Homologação com empresas piloto | **Pendente** | Plano em [piloto.md](piloto.md) |
| Preparação para produção | **Pendente** | Lista em [producao.md](producao.md) |

## Decisões que só você pode tomar

1. Profissional de SST e assessoria jurídica responsáveis (decisão 7).
2. Provedor de pagamento, valores dos planos e dias de tolerância.
3. Prazos de guarda e a data de início da contagem (com o jurídico).
4. Trabalhador sem conta no sistema: ciência colhida presencialmente e atestada
   pelo supervisor é aceitável? (com o jurídico e o SST).
5. Assinatura ICP-Brasil: onde, se em algum lugar, é exigida (com o jurídico).
6. Empresas piloto e duração do piloto.
