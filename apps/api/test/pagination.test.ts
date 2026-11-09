import request from 'supertest';
import { withContext } from '@sitedopai/db';
import { createWorld, destroyWorld, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  await withContext(w.owner, { tenantId: w.ids.beta }, async (tx) => {
    const b = await tx.selectFrom('aprs').selectAll().where('id', '=', w.ids.aprB!).executeTakeFirstOrThrow();
    // Mesma data de atualização para várias: o desempate pelo id não pode perder nem repetir itens.
    const same = new Date('2026-11-01T12:00:00Z');
    await tx.insertInto('aprs').values(Array.from({ length: 249 }, (_, i) => ({
      tenant_id: b.tenant_id, number: `APR-2026-${String(i + 100).padStart(6, '0')}`, template_version_id: b.template_version_id,
      risk_matrix_id: b.risk_matrix_id, unit_id: b.unit_id, activity_date: '2026-11-09', location: 'x', service_description: 'x',
      created_by: b.created_by, team: '[]', equipment: '[]', updated_at: i % 3 ? same : new Date(Date.UTC(2026, 9, 1, 0, i)),
    }))).execute();
  });
});
afterAll(async () => destroyWorld(w));

it('lista de APRs pagina por cursor sem perder nem repetir itens', async () => {
  const auth = `Bearer ${await token({ sub: 'sub-adminB' })}`;
  const seen: string[] = [];
  let after: { id: string; updated_at: string } | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const res = await http.get('/aprs').query(after ? { before: after.updated_at, beforeId: after.id } : {})
      .set('Authorization', auth).set('X-Tenant-Id', w.ids.beta!).expect(200);
    const page = res.body as { id: string; updated_at: string }[];
    seen.push(...page.map((r) => r.id));
    if (page.length < 100) break;
    after = page[page.length - 1]!;
  }
  expect(seen).toHaveLength(250);
  expect(new Set(seen).size).toBe(250);
});
