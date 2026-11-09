/**
 * Teste de carga local (Fase 6). Sobe a API real numa porta, cria dados
 * fictícios e mede latência e vazão de cenários típicos.
 *
 *   npx ts-node -T test/load/carga.ts [segundos-por-cenário]
 *
 * Gera docs/homologacao/carga-resultado.md. O gerador de carga roda na mesma
 * máquina que a API e o banco: os números servem para comparar versões e achar
 * gargalos, não como garantia de capacidade em produção.
 */
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { withContext } from '@sitedopai/db';
import { createWorld, destroyWorld, token } from '../setup';

const SECONDS = Number(process.argv[2] ?? 15);

interface Result { name: string; concurrency: number; requests: number; errors: number; statuses: Record<number, number>; rps: number; p50: number; p95: number; p99: number; max: number }

async function run(name: string, concurrency: number, fn: (vu: number, i: number) => Promise<Response>): Promise<Result> {
  const lat: number[] = [];
  const statuses: Record<number, number> = {};
  let errors = 0;
  const end = Date.now() + SECONDS * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, vu) => {
    let i = 0;
    while (Date.now() < end) {
      const s = performance.now();
      try {
        const r = await fn(vu, i++);
        await r.arrayBuffer();
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        if (r.status >= 500) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - s);
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]!);
  const r = { name, concurrency, requests: lat.length, errors, statuses, rps: Math.round(lat.length / secs), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(lat[lat.length - 1]!) };
  console.log(JSON.stringify(r));
  return r;
}

async function main() {
  const w = await createWorld();
  const server = await w.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = `Bearer ${await token({ sub: 'sub-adminB', expiresIn: '2h' })}`;
  const H = { Authorization: auth, 'X-Tenant-Id': w.ids.beta!, 'Content-Type': 'application/json' };

  // Volume: 2.000 APRs aprovadas e 60 em rascunho (uma por usuário virtual de escrita).
  const drafts: string[] = [];
  await withContext(w.owner, { tenantId: w.ids.beta }, async (tx) => {
    const base = await tx.selectFrom('aprs').selectAll().where('id', '=', w.ids.aprB!).executeTakeFirstOrThrow();
    const rows = Array.from({ length: 2060 }, (_, i) => ({
      tenant_id: base.tenant_id, number: `APR-2026-${String(i + 10).padStart(6, '0')}`, template_version_id: base.template_version_id,
      risk_matrix_id: base.risk_matrix_id, unit_id: base.unit_id, activity_date: '2026-11-09', location: `Local fictício ${i}`,
      service_description: 'Serviço fictício de carga', created_by: base.created_by, team: '[]', equipment: '[]',
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const ins = await tx.insertInto('aprs').values(rows.slice(i, i + 500)).returning('id').execute();
      drafts.push(...ins.map((r) => r.id));
    }
  });
  const writable = drafts.slice(-60);
  // O usuário do teste também recebe o papel SST (para preencher APRs).
  await withContext(w.owner, { tenantId: w.ids.beta }, (tx) => tx.insertInto('role_assignments')
    .values({ tenant_id: w.ids.beta!, membership_id: w.ids.m_adminB!, role: 'SST', scope_type: 'TENANT' }).execute());
  console.log(`dados prontos em ${base}`);

  const results: Result[] = [];
  results.push(await run('Listar APRs, 1ª página (GET /aprs)', 50, () => fetch(`${base}/aprs`, { headers: H })));
  results.push(await run('Listar PTs (GET /work-permits)', 50, () => fetch(`${base}/work-permits`, { headers: H })));
  results.push(await run('Abrir APR completa (GET /aprs/:id)', 50, (vu, i) => fetch(`${base}/aprs/${drafts[(vu * 37 + i) % 2000]}`, { headers: H })));
  const versions = new Map<string, number>();
  results.push(await run('Responder pergunta (PUT …/answers/:q)', 60, async (vu, i) => {
    const id = writable[vu]!;
    const r = await fetch(`${base}/aprs/${id}/answers/${w.ids.questionB}`, {
      method: 'PUT', headers: H, body: JSON.stringify({ answer: i % 2 ? 'YES' : 'NO', justification: i % 2 ? null : 'Justificativa fictícia de teste de carga', version: versions.get(id) }),
    });
    if (r.ok) {
      const b = await r.clone().json() as { version: number };
      versions.set(id, b.version);
    }
    return r;
  }));
  results.push(await run('Emitir PDF da APR (POST …/documents)', 5, () => fetch(`${base}/aprs/${w.ids.aprB}/documents`, { method: 'POST', headers: H })));
  results.push(await run('Verificar QR sem login (GET /verify/:code), 1 IP', 10, () => fetch(`${base}/verify/AAAAAAAAAAAAAAAAAAAAAAAA`)));

  const lines = [
    '# Teste de carga — resultado',
    '',
    `Gerado em ${new Date().toISOString()} · ${SECONDS} s por cenário · máquina: ${cpus().length} CPU, ${Math.round(totalmem() / 2 ** 30)} GB RAM`,
    '',
    'API, PostgreSQL 16 e gerador de carga na mesma máquina; pool de 10 conexões; armazenamento local.',
    'Volume: 2.061 APRs na empresa. Latências em milissegundos. O limite de 30 consultas/min por IP na verificação pública é intencional (429).',
    '',
    '| Cenário | Usuários simultâneos | Requisições | Req/s | p50 | p95 | p99 | máx | Erros 5xx | Respostas |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.concurrency} | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errors} | ${Object.entries(r.statuses).map(([k, v]) => `${k}: ${v}`).join(', ')} |`),
    '',
  ];
  writeFileSync(join(__dirname, '../../../../docs/homologacao/carga-resultado.md'), lines.join('\n'));
  await destroyWorld(w);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
