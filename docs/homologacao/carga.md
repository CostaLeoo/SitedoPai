# Teste de carga

Script: `apps/api/test/load/carga.ts` (`npx ts-node -T test/load/carga.ts 15`).
Sobe a API real, cria 2.061 APRs fictícias e mede seis cenários. O resultado
mais recente fica em [carga-resultado.md](carga-resultado.md).

## Leitura do resultado de 09/11/2026 (máquina de desenvolvimento)

- **Nenhum erro de servidor (5xx)** em mais de 20 mil requisições, e nenhum
  conflito de gravação com 60 pessoas respondendo APRs ao mesmo tempo.
- Leituras e gravações comuns: p95 entre 135 e 240 ms com 50–60 usuários
  simultâneos. O pool de 10 conexões com o banco é o limitador.
- **Emitir PDF leva cerca de 1 s** e ocupa o processador da API nesse tempo.
  Antes da produção: gerar o PDF em processo separado (fila), para não atrasar
  quem está liberando ou suspendendo uma PT.
- Verificação pública pelo QR: o limite de 30 consultas/min por IP funcionou
  (429). Em campo, várias pessoas atrás do mesmo IP (Wi-Fi da empresa, rede
  móvel com NAT) podem esbarrar nesse limite: **ajustar com dados do piloto**.

## Limitações

Gerador de carga, API e banco na mesma máquina; sem rede real, sem proxy, sem
S3. Os números servem para comparar versões e achar gargalos, não como
garantia de capacidade. Repetir no ambiente definitivo com metas acordadas
(nenhuma meta de desempenho foi definida na especificação).
