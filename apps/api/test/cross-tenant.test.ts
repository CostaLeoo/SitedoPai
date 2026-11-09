/**
 * Teste de vazamento entre empresas, gerado a partir da lista real de rotas.
 *
 * Toda rota da API precisa estar em CASES (testada contra dados da empresa B
 * por um administrador da empresa A) ou em OUTSIDE_TENANT (rotas sem empresa,
 * cobertas em api.test.ts). Uma rota nova que não esteja em nenhum dos dois
 * faz este teste falhar até ser classificada.
 */
import request from 'supertest';
import { createWorld, destroyWorld, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;
let authA: string;

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  authA = `Bearer ${await token({ sub: 'sub-adminA' })}`;
});
afterAll(async () => destroyWorld(w));

const OUTSIDE_TENANT = new Set(['GET /health', 'GET /me', 'GET /platform/tenants', 'POST /platform/tenants']);

type Case = (http: ReturnType<typeof request>) => Promise<void>;
const A = () => w.ids.alfa!;
const asA = (r: request.Test) => r.set('Authorization', authA).set('X-Tenant-Id', A());
const bodyHasNo = (body: unknown, values: string[]) => {
  const text = JSON.stringify(body);
  for (const v of values) expect(text).not.toContain(v);
};

const CASES: Record<string, Case> = {
  'GET /units': async () => {
    const res = await asA(http.get('/units')).expect(200);
    bodyHasNo(res.body, [w.ids.unitB1!, w.ids.unitC1!]);
  },
  'POST /units': async () => {
    // Um tenant_id no corpo é ignorado: a empresa vem só do contexto validado.
    const res = await asA(http.post('/units')).send({ name: 'Intrusa', code: 'X9', tenant_id: w.ids.beta, tenantId: w.ids.beta }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const ok = await asA(http.post('/units')).send({ name: 'Legítima', code: 'X9' }).expect(201);
    const asB = await http.get('/units').set('Authorization', `Bearer ${await token({ sub: 'sub-adminB' })}`).set('X-Tenant-Id', w.ids.beta!).expect(200);
    bodyHasNo(asB.body, [ok.body.id]);
  },
  'GET /units/:id': async () => {
    await asA(http.get(`/units/${w.ids.unitB1}`)).expect(404);
  },
  'PATCH /units/:id': async () => {
    await asA(http.patch(`/units/${w.ids.unitB1}`)).send({ name: 'invadida' }).expect(404);
  },
  'GET /units/:id/sectors': async () => {
    await asA(http.get(`/units/${w.ids.unitB1}/sectors`)).expect(404);
  },
  'POST /units/:id/sectors': async () => {
    await asA(http.post(`/units/${w.ids.unitB1}/sectors`)).send({ name: 'Intruso' }).expect(404);
  },
  'GET /memberships': async () => {
    const res = await asA(http.get('/memberships')).expect(200);
    bodyHasNo(res.body, ['adminb@exemplo.test', w.ids.m_adminB!]);
  },
  'POST /memberships': async () => {
    await asA(http.post('/memberships'))
      .send({ email: 'z@exemplo.test', displayName: 'Z', roles: [{ role: 'EXECUTOR', unitId: w.ids.unitB1 }] }).expect(400);
  },
  'PATCH /memberships/:id': async () => {
    await asA(http.patch(`/memberships/${w.ids.m_adminB}`)).send({ status: 'SUSPENDED' }).expect(404);
  },
  'GET /audit-events': async () => {
    const res = await asA(http.get('/audit-events')).expect(200);
    for (const e of res.body as { entity_id: string }[]) {
      expect([w.ids.unitB1, w.ids.sectorB1, w.ids.m_adminB]).not.toContain(e.entity_id);
    }
  },
  'GET /audit-events/verify': async () => {
    const before = await asA(http.get('/audit-events/verify')).expect(200);
    const authB = `Bearer ${await token({ sub: 'sub-adminB' })}`;
    await http.post('/units').set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).send({ name: 'B novo', code: 'BN' }).expect(201);
    const after = await asA(http.get('/audit-events/verify')).expect(200);
    expect(after.body.events).toBe(before.body.events);
  },
};

function listRoutes(): string[] {
  const router = w.app.getHttpAdapter().getInstance().router as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  return router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route!.methods).filter((m) => m !== '_all').map((m) => `${m.toUpperCase()} ${l.route!.path}`))
    .sort();
}

describe('isolamento entre empresas em todas as rotas', () => {
  it('toda rota está classificada (com caso de teste ou fora do escopo de empresa)', () => {
    const unclassified = listRoutes().filter((r) => !(r in CASES) && !OUTSIDE_TENANT.has(r));
    expect(unclassified).toEqual([]);
    expect(listRoutes().length).toBe(Object.keys(CASES).length + OUTSIDE_TENANT.size);
  });

  it.each(Object.keys(CASES))('%s não expõe nem altera dados da empresa B', async (route) => {
    await CASES[route]!(http);
  });

  it('os dados da empresa B continuam intactos', async () => {
    const authB = `Bearer ${await token({ sub: 'sub-adminB' })}`;
    const unit = await http.get(`/units/${w.ids.unitB1}`).set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(unit.body.name).toBe('Unidade B1');
    const members = await http.get('/memberships').set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(members.body.map((m: { status: string }) => m.status)).toEqual(['ACTIVE']);
    const sectors = await http.get(`/units/${w.ids.unitB1}/sectors`).set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(sectors.body.map((s: { name: string }) => s.name)).toEqual(['Manutenção']);
  });
});
