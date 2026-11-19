/**
 * Teste de vazamento entre empresas, gerado a partir da lista real de rotas.
 *
 * Toda rota da API precisa estar em CASES (testada contra dados da empresa B
 * por um administrador da empresa A) ou em OUTSIDE_TENANT (rotas sem empresa,
 * cobertas em api.test.ts). Uma rota nova que não esteja em nenhum dos dois
 * faz este teste falhar até ser classificada.
 */
import { unzipSync } from 'fflate';
import request from 'supertest';
import { createWorld, destroyWorld, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;
let authA: string;
let sstA: string;

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  authA = `Bearer ${await token({ sub: 'sub-adminA' })}`;
  sstA = `Bearer ${await token({ sub: 'sub-sstA' })}`;
  // Documento emitido, regra e retenção da Beta (alvos da Fase 4).
  const authB = `Bearer ${await token({ sub: 'sub-adminB' })}`;
  const asBeta = (r: request.Test) => r.set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!);
  w.ids.docB = (await asBeta(http.post(`/aprs/${w.ids.aprB}/documents`)).expect(201)).body.id;
  w.ids.ruleB = (await asBeta(http.post('/retention-rules')).send({ documentType: 'apr', minYears: 5, source: 'INTERNAL', basis: SECRET }).expect(201)).body.id;
  w.ids.holdB = (await asBeta(http.post('/legal-holds')).send({ documentType: 'apr', documentId: w.ids.aprB, reason: SECRET }).expect(201)).body.id;
});
afterAll(async () => destroyWorld(w));

// GET /verify/:code é pública por desenho (QR Code); seu conteúdo é testado em documents.test.ts.
// Rotas /platform/* só aceitam o administrador da plataforma (billing.test.ts confere
// que o administrador de empresa recebe 403 em todas). O webhook é autenticado por HMAC.
const OUTSIDE_TENANT = new Set(['GET /health', 'GET /me', 'GET /platform/tenants', 'POST /platform/tenants', 'GET /verify/:code',
  'GET /platform/plans', 'POST /platform/plans', 'PATCH /platform/plans/:id', 'GET /platform/billing/overview', 'GET /platform/tenants/:id/billing',
  'POST /platform/tenants/:id/subscription', 'POST /platform/tenants/:id/subscription/cancel', 'POST /platform/tenants/:id/status',
  'POST /platform/billing/sync', 'POST /platform/billing/simulate', 'POST /billing/webhooks/:provider']);

type Case = (http: ReturnType<typeof request>) => Promise<void>;
const A = () => w.ids.alfa!;
const asA = (r: request.Test) => r.set('Authorization', authA).set('X-Tenant-Id', A());
/** Atacante com permissão de escrita em SST e APR na empresa A inteira. */
const asSst = (r: request.Test) => r.set('Authorization', sstA).set('X-Tenant-Id', A());
const B = (k: string) => w.ids[k]!;
const SECRET = 'Segredo da Beta';
const bodyHasNo = (body: unknown, values: string[]) => {
  const text = JSON.stringify(body);
  for (const v of values) expect(text).not.toContain(v);
};

const CASES: Record<string, Case> = {
  'POST /exports': async () => {
    const res = await asA(http.post('/exports')).buffer(true).parse((r, cb) => {
      const c: Buffer[] = [];
      r.on('data', (d: Buffer) => c.push(d));
      r.on('end', () => cb(null, Buffer.concat(c)));
    }).expect(200);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    const all = Object.entries(files).map(([k, v]) => k + new TextDecoder().decode(v)).join('\n');
    for (const v of [SECRET, 'Telhado Beta', 'Tanque Beta', 'Trabalhador Beta', B('aprB'), B('ptB'), B('beta'), 'APR-2026-000001-emissao']) expect(all).not.toContain(v);
  },
  'GET /dashboard': async () => { bodyHasNo((await asSst(http.get('/dashboard')).expect(200)).body, [B('aprB'), B('ptB'), SECRET, 'Telhado Beta', 'Tanque Beta']); },
  'GET /billing': async () => { bodyHasNo((await asA(http.get('/billing')).expect(200)).body, [B('beta'), SECRET]); },
  'POST /aprs/:id/documents': async () => { await asA(http.post(`/aprs/${B('aprB')}/documents`)).expect(404); },
  'POST /work-permits/:id/documents': async () => { await asA(http.post(`/work-permits/${B('ptB')}/documents`)).expect(404); },
  'GET /documents': async () => {
    await asA(http.get('/documents').query({ documentType: 'apr', documentId: B('aprB') })).expect(404);
    await asA(http.get('/documents').query({ documentType: 'work_permit', documentId: B('ptB') })).expect(404);
  },
  'GET /documents/:id/file': async () => { await asA(http.get(`/documents/${B('docB')}/file`)).expect(404); },
  'GET /retention-rules': async () => { bodyHasNo((await asA(http.get('/retention-rules')).expect(200)).body, [B('ruleB'), SECRET]); },
  'POST /retention-rules': async () => {
    await asA(http.post('/retention-rules')).send({ documentType: 'apr', minYears: 5, source: 'INTERNAL', basis: 'x x x x x', tenantId: B('beta') }).expect(400);
  },
  'POST /retention-rules/:id/deactivate': async () => { await asA(http.post(`/retention-rules/${B('ruleB')}/deactivate`)).expect(404); },
  'GET /legal-holds': async () => { bodyHasNo((await asA(http.get('/legal-holds')).expect(200)).body, [B('holdB'), SECRET]); },
  'POST /legal-holds': async () => {
    await asA(http.post('/legal-holds')).send({ documentType: 'apr', documentId: B('aprB'), reason: 'tentativa' }).expect(404);
  },
  'POST /legal-holds/:id/release': async () => { await asA(http.post(`/legal-holds/${B('holdB')}/release`)).send({ reason: 'tentativa' }).expect(404); },
  'GET /retention/report': async () => { bodyHasNo((await asA(http.get('/retention/report')).expect(200)).body, [B('aprB'), B('ptB'), SECRET]); },
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
  // ---- Fase 2a: matriz, modelos, biblioteca, APR, fotos ----
  'GET /risk-matrices': async () => {
    bodyHasNo((await asSst(http.get('/risk-matrices')).expect(200)).body, [B('matrixB'), 'Matriz Beta']);
  },
  'POST /risk-matrices': async () => {
    const { MATRIX } = await import('./setup');
    await asSst(http.post('/risk-matrices')).send({ ...MATRIX, name: 'Matriz Beta', tenantId: B('beta') }).expect(400);
  },
  'POST /risk-matrices/:id/publish': async () => {
    await asSst(http.post(`/risk-matrices/${B('matrixB')}/publish`)).expect(404);
  },
  'GET /apr-templates': async () => {
    bodyHasNo((await asSst(http.get('/apr-templates')).expect(200)).body, [B('templateB'), 'Altura Beta']);
  },
  'POST /apr-templates': async () => {
    await asSst(http.post('/apr-templates')).send({ name: 'X', serviceType: 'x', tenant_id: B('beta') }).expect(400);
  },
  'POST /apr-templates/:id/versions': async () => {
    await asSst(http.post(`/apr-templates/${B('templateB')}/versions`)).expect(404);
  },
  'GET /apr-template-versions/:id': async () => {
    await asSst(http.get(`/apr-template-versions/${B('versionB')}`)).expect(404);
  },
  'PUT /apr-template-versions/:id/questions': async () => {
    await asSst(http.put(`/apr-template-versions/${B('versionB')}/questions`)).send({ questions: [{
      text: 'x', expectedAnswer: 'YES', criticality: 'LOW', required: true, allowNa: false, justificationOn: [],
      photosRequired: 0, photosMax: 0, mismatchEffect: 'ALERT' }] }).expect(404);
  },
  'POST /apr-template-versions/:id/submit': async () => {
    await asSst(http.post(`/apr-template-versions/${B('versionB')}/submit`)).expect(400);
  },
  'POST /apr-template-versions/:id/review': async () => {
    await asSst(http.post(`/apr-template-versions/${B('versionB')}/review`)).send({ approve: false, note: 'x' }).expect(404);
  },
  'GET /hazard-library': async () => {
    await asSst(http.get('/hazard-library?q=%25')).expect(200);
  },
  'POST /hazard-library': async () => {
    await asSst(http.post('/hazard-library')).send({ hazard: 'h', consequence: 'c', suggestedControls: [], tenantId: B('beta') }).expect(400);
  },
  'GET /aprs': async () => {
    bodyHasNo((await asSst(http.get('/aprs')).expect(200)).body, [B('aprB'), SECRET]);
  },
  'POST /aprs': async () => {
    // Referências da empresa B: o banco não as enxerga, então a criação falha.
    await asSst(http.post('/aprs')).send({ templateVersionId: B('versionB'), riskMatrixId: B('matrixB'), unitId: B('unitB1'), activityDate: '2026-11-12' }).expect(400);
  },
  'GET /aprs/:id': async () => {
    await asSst(http.get(`/aprs/${B('aprB')}`)).expect(404);
  },
  'PATCH /aprs/:id': async () => {
    await asSst(http.patch(`/aprs/${B('aprB')}`)).send({ rowVersion: 1, location: 'invadido' }).expect(404);
  },
  'PUT /aprs/:id/answers/:questionId': async () => {
    await asSst(http.put(`/aprs/${B('aprB')}/answers/${B('questionB')}`)).send({ answer: 'NO', version: 1 }).expect(404);
  },
  'POST /aprs/:id/answers/:questionId/reassess': async () => {
    await asSst(http.post(`/aprs/${B('aprB')}/answers/${B('questionB')}/reassess`)).send({ answer: 'YES', version: 1 }).expect(404);
  },
  'PUT /aprs/:id/analysis': async () => {
    await asSst(http.put(`/aprs/${B('aprB')}/analysis`)).send({ analysisVersion: 1, steps: [] }).expect(404);
  },
  'GET /aprs/:id/check': async () => {
    await asSst(http.get(`/aprs/${B('aprB')}/check`)).expect(404);
  },
  'POST /aprs/:id/submit': async () => {
    await asSst(http.post(`/aprs/${B('aprB')}/submit`)).expect(404);
  },
  'POST /aprs/:id/approve': async () => {
    await asSst(http.post(`/aprs/${B('aprB')}/approve`)).send({}).expect(404);
  },
  'POST /aprs/:id/return': async () => {
    await asSst(http.post(`/aprs/${B('aprB')}/return`)).send({ note: 'x' }).expect(404);
  },
  'POST /aprs/:id/cancel': async () => {
    await asSst(http.post(`/aprs/${B('aprB')}/cancel`)).send({ note: 'x' }).expect(404);
  },
  'POST /aprs/:id/revise': async () => {
    await asSst(http.post(`/aprs/${B('aprB')}/revise`)).expect(404);
  },
  'GET /aprs/:id/history': async () => {
    await asSst(http.get(`/aprs/${B('aprB')}/history`)).expect(404);
  },
  'POST /aprs/:id/questions/:questionId/photos': async () => {
    const sharp = (await import('sharp')).default;
    const img = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer();
    await asSst(http.post(`/aprs/${B('aprB')}/questions/${B('questionB')}/photos`)).attach('file', img, 'a.jpg').expect(404);
  },
  'GET /aprs/:id/photos/:photoId': async () => {
    await asSst(http.get(`/aprs/${B('aprB')}/photos/${B('photoB')}`)).expect(404);
  },
  'GET /aprs/:id/photos/:photoId/original': async () => {
    await asSst(http.get(`/aprs/${B('aprB')}/photos/${B('photoB')}/original`)).expect(404);
  },
  'DELETE /aprs/:id/photos/:photoId': async () => {
    await asSst(http.delete(`/aprs/${B('aprB')}/photos/${B('photoB')}`)).expect(404);
  },
  // ---- Fase 3a: pessoas, tipos de PT, PT ----
  'GET /workers': async () => { bodyHasNo((await asSst(http.get('/workers')).expect(200)).body, [B('workerB'), 'Trabalhador Beta']); },
  'POST /workers': async () => { await asSst(http.post('/workers')).send({ fullName: 'X', userId: B('adminB') }).expect(400); },
  'PATCH /workers/:id': async () => { await asSst(http.patch(`/workers/${B('workerB')}`)).send({ active: false }).expect(404); },
  'GET /qualification-types': async () => { bodyHasNo((await asSst(http.get('/qualification-types')).expect(200)).body, [B('qualTypeB'), 'Treinamento Beta']); },
  'POST /qualification-types': async () => { await asSst(http.post('/qualification-types')).send({ name: 'X', kind: 'OTHER', tenantId: B('beta') }).expect(400); },
  'GET /workers/:id/qualifications': async () => { await asSst(http.get(`/workers/${B('workerB')}/qualifications`)).expect(404); },
  'POST /workers/:id/qualifications': async () => {
    await asSst(http.post(`/workers/${B('workerB')}/qualifications`)).send({ typeId: B('qualTypeB'), validFrom: '2026-01-01', validUntil: '2027-01-01' }).expect(404);
  },
  'POST /worker-qualifications/:id/revoke': async () => { await asSst(http.post(`/worker-qualifications/${B('workerQualB')}/revoke`)).send({ reason: 'x' }).expect(404); },
  'GET /pt-types': async () => { bodyHasNo((await asSst(http.get('/pt-types')).expect(200)).body, [B('ptTypeB'), 'PT Beta']); },
  'POST /pt-types': async () => {
    await asSst(http.post('/pt-types')).send({ name: 'X', checklistTemplateVersionId: B('versionB'), maxValidityMinutes: 60, requiresGasMonitoring: false,
      gasParameters: [], gasMaxAgeMinutes: null, requiresEntryLog: false, releaserQualificationTypeId: null, segregateCreatorReleaser: true, requirements: [] }).expect(400);
  },
  'PUT /pt-types/:id': async () => {
    await asSst(http.put(`/pt-types/${B('ptTypeB')}`)).send({ name: 'PT Beta', checklistTemplateVersionId: B('versionB'), maxValidityMinutes: 60, requiresGasMonitoring: false,
      gasParameters: [], gasMaxAgeMinutes: null, requiresEntryLog: false, releaserQualificationTypeId: null, segregateCreatorReleaser: true, requirements: [] }).expect(404);
  },
  'POST /pt-types/:id/publish': async () => {
    await asSst(http.post(`/pt-types/${B('ptTypeB')}/publish`)).send({ professionalValidation: { name: 'x', registry: 'y', date: '2026-11-01' } }).expect(404);
  },
  'GET /work-permits': async () => { bodyHasNo((await asSst(http.get('/work-permits')).expect(200)).body, [B('ptB'), SECRET]); },
  'POST /work-permits': async () => {
    await asSst(http.post('/work-permits')).send({ ptTypeId: B('ptTypeB'), aprId: B('aprB'), location: 'x', description: 'x',
      startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString() }).expect(400);
  },
  'GET /work-permits/:id': async () => { await asSst(http.get(`/work-permits/${B('ptB')}`)).expect(404); },
  'GET /work-permits/:id/check': async () => { await asSst(http.get(`/work-permits/${B('ptB')}/check`)).expect(404); },
  'GET /work-permits/:id/validity': async () => { await asSst(http.get(`/work-permits/${B('ptB')}/validity`)).expect(404); },
  'GET /work-permits/:id/signatures': async () => { await asSst(http.get(`/work-permits/${B('ptB')}/signatures`)).expect(404); },
  'GET /work-permits/:id/history': async () => { await asSst(http.get(`/work-permits/${B('ptB')}/history`)).expect(404); },
  'PATCH /work-permits/:id': async () => { await asSst(http.patch(`/work-permits/${B('ptB')}`)).send({ rowVersion: 1, location: 'invadido' }).expect(404); },
  'PUT /work-permits/:id/team': async () => {
    await asSst(http.put(`/work-permits/${B('ptB')}/team`)).send({ rowVersion: 1, members: [{ workerId: B('workerB'), function: 'EXECUTOR' }] }).expect(404);
  },
  'PUT /work-permits/:id/answers/:questionId': async () => {
    await asSst(http.put(`/work-permits/${B('ptB')}/answers/${B('questionB')}`)).send({ answer: 'NO' }).expect(404);
  },
  'POST /work-permits/:id/answers/:questionId/reassess': async () => {
    await asSst(http.post(`/work-permits/${B('ptB')}/answers/${B('questionB')}/reassess`)).send({ answer: 'YES', version: 1 }).expect(404);
  },
  'POST /work-permits/:id/submit': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/submit`)).expect(404); },
  'POST /work-permits/:id/review': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/review`)).send({ approve: true }).expect(404); },
  'POST /work-permits/:id/measurements': async () => {
    await asSst(http.post(`/work-permits/${B('ptB')}/measurements`)).send({ parameterKey: 'o2', value: 20, instrument: 'x' }).expect(404);
  },
  'POST /work-permits/:id/release': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/release`)).expect(404); },
  'POST /work-permits/:id/resume': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/resume`)).expect(404); },
  'POST /work-permits/:id/acknowledge': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/acknowledge`)).expect(404); },
  'POST /work-permits/:id/start': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/start`)).expect(404); },
  'POST /work-permits/:id/suspend': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/suspend`)).send({ reason: 'x' }).expect(404); },
  'POST /work-permits/:id/entries': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/entries`)).send({ workerId: B('workerB') }).expect(404); },
  'POST /work-permits/:id/entries/:entryId/exit': async () => {
    await asSst(http.post(`/work-permits/${B('ptB')}/entries/00000000-0000-4000-8000-000000000000/exit`)).expect(404);
  },
  'POST /work-permits/:id/close': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/close`)).send({ areaReleased: true, teamOut: true }).expect(404); },
  'POST /work-permits/:id/cancel': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/cancel`)).send({ reason: 'x' }).expect(404); },
  'POST /work-permits/:id/reject': async () => { await asSst(http.post(`/work-permits/${B('ptB')}/reject`)).send({ reason: 'x' }).expect(404); },
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
    const apr = await http.get(`/aprs/${B('aprB')}`).set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(apr.body).toMatchObject({ status: 'APPROVED', location: 'Telhado Beta', rowVersion: 1, analysisVersion: 1 });
    const pt = await http.get(`/work-permits/${B('ptB')}`).set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(pt.body).toMatchObject({ status: 'DRAFT', location: 'Tanque Beta', row_version: 1 });
    expect(pt.body.team).toEqual([]);
    const wq = await http.get(`/workers/${B('workerB')}/qualifications`).set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(wq.body[0].revoked_at).toBeNull();
    expect(apr.body.answers.map((a: { answer: string }) => a.answer)).toEqual(['YES']);
    expect(apr.body.photos).toHaveLength(1);
    const versions = await http.get('/apr-templates').set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(versions.body[0].versions.map((v: { status: string }) => v.status)).toEqual(['PUBLISHED']);
    const holds = await http.get('/legal-holds').set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(holds.body.map((h: { released_at: unknown }) => h.released_at)).toEqual([null]);
    const rules = await http.get('/retention-rules').set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(rules.body.map((r: { active: boolean }) => r.active)).toEqual([true]);
    const docs = await http.get('/documents').query({ documentType: 'apr', documentId: B('aprB') }).set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!).expect(200);
    expect(docs.body).toHaveLength(1);
  });
});
