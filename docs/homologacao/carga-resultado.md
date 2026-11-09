# Teste de carga — resultado

Gerado em 2026-11-09T17:41:29.785Z · 15 s por cenário · máquina: 2 CPU, 8 GB RAM

API, PostgreSQL 16 e gerador de carga na mesma máquina; pool de 10 conexões; armazenamento local.
Volume: 2.061 APRs na empresa. Latências em milissegundos. O limite de 30 consultas/min por IP na verificação pública é intencional (429).

| Cenário | Usuários simultâneos | Requisições | Req/s | p50 | p95 | p99 | máx | Erros 5xx | Respostas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Listar APRs, 1ª página (GET /aprs) | 50 | 4156 | 275 | 175 | 235 | 264 | 440 | 0 | 200: 4156 |
| Listar PTs (GET /work-permits) | 50 | 7048 | 468 | 104 | 135 | 170 | 201 | 0 | 200: 7048 |
| Abrir APR completa (GET /aprs/:id) | 50 | 4461 | 295 | 167 | 203 | 233 | 279 | 0 | 200: 4461 |
| Responder pergunta (PUT …/answers/:q) | 60 | 4557 | 301 | 197 | 239 | 281 | 313 | 0 | 200: 4557 |
| Emitir PDF da APR (POST …/documents) | 5 | 74 | 5 | 1050 | 1160 | 1301 | 1301 | 0 | 201: 74 |
| Verificar QR sem login (GET /verify/:code), 1 IP | 10 | 36572 | 2438 | 3 | 9 | 12 | 40 | 0 | 404: 30, 429: 36542 |
