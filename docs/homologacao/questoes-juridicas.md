# Questões para a assessoria jurídica

O sistema foi construído sem assumir exigências legais que não estavam na
especificação. As respostas abaixo definem configurações e, em alguns casos,
mudanças no produto. Cada pergunta indica o que muda no sistema.

## Assinatura eletrônica
1. A assinatura usada hoje (login no provedor de identidade, login recente,
   segundo fator para liberar e retomar; hash do conteúdo assinado; data e hora
   do servidor; IP, navegador e sessão) é suficiente para APR e PT, ou algum ato
   exige certificado ICP-Brasil? → define se entra assinatura PAdES no PDF.
2. Qual o enquadramento dessa assinatura (por exemplo, à luz da MP 2.200-2/2001
   e da Lei 14.063/2020)? → texto exibido no PDF e nos termos de uso.
3. Trabalhador sem conta: a ciência presencial, atestada pelo supervisor no
   sistema, tem valor equivalente? → libera ou não esse fluxo.

## Guarda de documentos
4. Prazos mínimos de guarda de APR, PT, medições, assinaturas e auditoria, por
   tipo de atividade. → cadastrados como regras de origem LEGAL (não podem ser
   desativadas).
5. A partir de quando conta o prazo: aprovação da APR, encerramento da PT, fim
   da validade? → hoje: decisão da APR; encerramento da PT ou fim da validade.
6. Após o fim do contrato, quem guarda (cliente, plataforma ou ambos), por
   quanto tempo e com que acesso? → regras de encerramento e exportação.

## LGPD
7. Papéis: a empresa cliente como controladora e a plataforma como operadora?
   → contrato de tratamento de dados.
8. Base legal para nomes, matrículas, qualificações, fotos e dados de acesso
   (IP, navegador). → política de privacidade.
9. A página pública do QR mostra tipo, número, empresa (nome fantasia), datas,
   hash e situação, sem nomes de pessoas nem local. Está adequado?
10. Pedido de exclusão de um trabalhador: como conciliar com a guarda
    obrigatória? → procedimento de atendimento ao titular.
11. Transferência internacional: provedores de nuvem, e-mail e pagamento fora
    do Brasil. → escolha de fornecedores e cláusulas.

## Comercial
12. Termos de uso, SLA e limitação de responsabilidade, em especial: o sistema
    apoia, mas não substitui, a avaliação do SST.
13. Suspensão por falta de pagamento: o modo somente consulta (com ações de
    segurança liberadas) está adequado aos contratos?
14. Nota fiscal de serviço e tributação da assinatura (com o contador).
