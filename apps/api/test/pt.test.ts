/**
 * Fluxo da Permissão de Trabalho (exemplo: espaço confinado). Os limites de
 * gases e a validade usados aqui são DADOS DE TESTE, não valores normativos:
 * no produto, quem define é o SST de cada empresa no tipo de PT.
 */
import request from 'supertest';
import { withContext } from '@sitedopai/db';
import { createWorld, destroyWorld, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;
const A = () => w.ids.alfa!;
const api = async (user: string, opts: { mfa?: boolean; authAgeSeconds?: number } = {}) => {
  const auth = `Bearer ${await token({ sub: `sub-${user}`, ...opts })}`;
  const h = (r: request.Test) => r.set('Authorization', auth).set('X-Tenant-Id', A());
  return { get: (u: string) => h(http.get(u)), post: (u: string) => h(http.post(u)), put: (u: string) => h(http.put(u)), patch: (u: string) => h(http.patch(u)) };
};
const ids: Record<string, string> = {};
const iso = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
const GOOD_GAS = [{ parameterKey: 'o2', value: 20.9 }, { parameterKey: 'lie', value: 0 }];
const measureAll = async (values = GOOD_GAS) => {
  for (const v of values) await (await api('execA')).post(`/work-permits/${ids.pt}/measurements`).send({ ...v, instrument: 'Detector 4 gases SN 0001 (teste)' }).expect(201);
};

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  // Base pronta direto no banco: matriz, modelos publicados (APR e checklist da PT) e APR aprovada.
  await withContext(w.owner, { tenantId: A() }, async (tx) => {
    const m = await tx.insertInto('risk_matrices').values({
      tenant_id: A(), name: 'M', created_by: w.ids.sstA!, status: 'PUBLISHED',
      probability_levels: JSON.stringify([{ value: 1, label: '1' }, { value: 2, label: '2' }]), severity_levels: JSON.stringify([{ value: 1, label: '1' }, { value: 2, label: '2' }]),
      classes: JSON.stringify([{ min: 1, max: 2, label: 'ok', acceptable: true }, { min: 3, max: 4, label: 'não', acceptable: false }]),
    }).returning('id').executeTakeFirstOrThrow();
    const tpl = await tx.insertInto('apr_templates').values({ tenant_id: A(), name: 'Checklist PT espaço confinado', service_type: 'pt', created_by: w.ids.sstA! }).returning('id').executeTakeFirstOrThrow();
    const v = await tx.insertInto('apr_template_versions').values({ tenant_id: A(), template_id: tpl.id, version: 1, author_id: w.ids.sstA! }).returning('id').executeTakeFirstOrThrow();
    const qs = await tx.insertInto('apr_template_questions').values([
      { tenant_id: A(), template_version_id: v.id, position: 1, text: 'Ventilação instalada e funcionando?', expected_answer: 'YES', criticality: 'CRITICAL', mismatch_effect: 'BLOCK' },
      { tenant_id: A(), template_version_id: v.id, position: 2, text: 'Energias perigosas bloqueadas e etiquetadas?', expected_answer: 'YES', criticality: 'HIGH', mismatch_effect: 'PENDING' },
    ]).returning('id').execute();
    await tx.updateTable('apr_template_versions').set({ status: 'PUBLISHED', reviewed_by: w.ids.sst2A!, professional_validation: JSON.stringify({ name: 'x', registry: 'y', date: '2026-11-01' }) })
      .where('id', '=', v.id).execute();
    const draftApr = await tx.insertInto('aprs').values({ tenant_id: A(), number: 'APR-2026-000099', template_version_id: v.id, risk_matrix_id: m.id, unit_id: w.ids.unitA1!,
      activity_date: '2026-11-09', created_by: w.ids.execA!, team: '[]', equipment: '[]' }).returning('id').executeTakeFirstOrThrow();
    const apr = await tx.insertInto('aprs').values({ tenant_id: A(), number: 'APR-2026-000100', template_version_id: v.id, risk_matrix_id: m.id, unit_id: w.ids.unitA1!,
      activity_date: '2026-11-09', created_by: w.ids.execA!, team: '[]', equipment: '[]' }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('aprs').set({ status: 'IN_REVIEW' }).where('id', '=', apr.id).execute();
    await tx.updateTable('aprs').set({ status: 'APPROVED', decided_by: w.ids.supA1! }).where('id', '=', apr.id).execute();
    Object.assign(ids, { checklist: v.id, q1: qs[0]!.id, q2: qs[1]!.id, apr: apr.id, draftApr: draftApr.id });
  });
});
afterAll(async () => destroyWorld(w));

describe('cadastros: qualificações, trabalhadores e tipo de PT', () => {
  it('SST cadastra tipos de qualificação e trabalhadores', async () => {
    const sst = await api('sstA');
    for (const [k, name, kind] of [['autorizado', 'Capacitação trabalhador autorizado (teste)', 'TRAINING'], ['supervisor', 'Capacitação supervisor de entrada (teste)', 'TRAINING'],
      ['vigia', 'Capacitação vigia (teste)', 'TRAINING'], ['liberador', 'Designação: responsável pela liberação de PT', 'DESIGNATION']] as const) {
      ids[`qt_${k}`] = (await sst.post('/qualification-types').send({ name, kind }).expect(201)).body.id;
    }
    for (const [k, fullName, user] of [['exec', 'Edson Executante', w.ids.execA], ['sup', 'Sueli Supervisora', w.ids.supA1], ['vigia', 'Silvia Vigia', w.ids.sst2A], ['terceiro', 'Tadeu Terceiro (sem conta)', undefined]] as const) {
      ids[`w_${k}`] = (await sst.post('/workers').send({ fullName, ...(user ? { userId: user } : {}) }).expect(201)).body.id;
    }
    // Usuário de outra empresa não pode ser vinculado a trabalhador desta.
    await sst.post('/workers').send({ fullName: 'Intruso', userId: w.ids.adminB }).expect(400);
  });

  it('registra qualificações; treinamento exige validade; registro é imutável e revogável', async () => {
    const sst = await api('sstA');
    const add = (wk: string, qt: string, until: string | null = '2027-12-31') =>
      sst.post(`/workers/${ids[`w_${wk}`]}/qualifications`).send({ typeId: ids[`qt_${qt}`], validFrom: '2026-01-01', validUntil: until });
    await add('exec', 'autorizado', null).expect(400);
    await add('exec', 'autorizado').expect(201);
    await add('terceiro', 'autorizado').expect(201);
    await add('vigia', 'vigia').expect(201);
    await add('sup', 'supervisor').expect(201);
    await add('sup', 'liberador', null).expect(201);
    const wrong = (await add('exec', 'supervisor').expect(201)).body.id;
    await sst.post(`/worker-qualifications/${wrong}/revoke`).send({ reason: 'Registrado por engano' }).expect(201);
    await sst.post(`/worker-qualifications/${wrong}/revoke`).send({ reason: 'De novo' }).expect(404);
    const list = await sst.get(`/workers/${ids.w_exec}/qualifications`).expect(200);
    expect(list.body.find((q: { id: string }) => q.id === wrong).revoke_reason).toBe('Registrado por engano');
  });

  it('SST configura o tipo de PT; publicação exige outra pessoa', async () => {
    const body = {
      name: 'Espaço confinado (teste)', checklistTemplateVersionId: ids.checklist, maxValidityMinutes: 480,
      requiresGasMonitoring: true, gasMaxAgeMinutes: 30, requiresEntryLog: true, segregateCreatorReleaser: true,
      gasParameters: [{ key: 'o2', label: 'Oxigênio', unit: '%', min: 19.5, max: 23 }, { key: 'lie', label: 'Inflamáveis', unit: '%LIE', max: 10 }],
      releaserQualificationTypeId: ids.qt_liberador,
      requirements: [
        { function: 'EXECUTOR', minCount: 1, qualificationTypeIds: [ids.qt_autorizado] },
        { function: 'ENTRY_SUPERVISOR', minCount: 1, qualificationTypeIds: [ids.qt_supervisor] },
        { function: 'ATTENDANT', minCount: 1, qualificationTypeIds: [ids.qt_vigia] },
      ],
    };
    const sst = await api('sstA');
    await sst.post('/pt-types').send({ ...body, requiresGasMonitoring: true, gasParameters: [] }).expect(400);
    ids.type = (await sst.post('/pt-types').send(body).expect(201)).body.id;
    const pv = { professionalValidation: { name: 'Eng. Fictício', registry: 'CREA-SP 0000000', date: '2026-11-09' } };
    await sst.post(`/pt-types/${ids.type}/publish`).send(pv).expect(403);
    await (await api('sst2A')).post(`/pt-types/${ids.type}/publish`).send(pv).expect(201);
    await sst.put(`/pt-types/${ids.type}`).send(body).expect(400);
  });
});

describe('PT: preparação e análise', () => {
  it('exige APR aprovada e respeita a validade máxima do tipo', async () => {
    const ex = await api('execA');
    const base = { ptTypeId: ids.type, location: 'Tanque T-01', description: 'Limpeza interna do tanque', startsAt: iso(-5), endsAt: iso(240) };
    expect((await ex.post('/work-permits').send({ ...base, aprId: ids.draftApr }).expect(400)).body.code).toBe('APR_NOT_APPROVED');
    expect((await ex.post('/work-permits').send({ ...base, aprId: ids.apr, endsAt: iso(600) }).expect(400)).body.code).toBe('VALIDITY_TOO_LONG');
    const r = await ex.post('/work-permits').send({ ...base, aprId: ids.apr }).expect(201);
    expect(r.body.number).toBe('PT-2026-000001');
    ids.pt = r.body.id;
  });

  it('a verificação aponta funções, qualificações e pessoas sem conta', async () => {
    const ex = await api('execA');
    await ex.put(`/work-permits/${ids.pt}/team`).send({ rowVersion: 1, members: [
      { workerId: ids.w_exec, function: 'EXECUTOR' }, { workerId: ids.w_terceiro, function: 'EXECUTOR' }, { workerId: ids.w_exec, function: 'ENTRY_SUPERVISOR' },
    ] }).expect(200);
    const c = (await ex.get(`/work-permits/${ids.pt}/check`).expect(200)).body;
    const codes = c.blocking.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['TEAM_FUNCTION_MISSING', 'QUALIFICATION_MISSING', 'WORKER_WITHOUT_ACCOUNT', 'ANSWER_REQUIRED']));
    expect(c.blocking.find((i: { code: string }) => i.code === 'QUALIFICATION_MISSING').message).toMatch(/Edson.*supervisor de entrada/);
  });

  it('com equipe qualificada e checklist respondido, segue para análise', async () => {
    const ex = await api('execA');
    await ex.put(`/work-permits/${ids.pt}/team`).send({ rowVersion: 2, members: [
      { workerId: ids.w_exec, function: 'EXECUTOR' }, { workerId: ids.w_sup, function: 'ENTRY_SUPERVISOR' }, { workerId: ids.w_vigia, function: 'ATTENDANT' },
    ] }).expect(200);
    await ex.put(`/work-permits/${ids.pt}/answers/${ids.q1}`).send({ answer: 'YES' }).expect(200);
    await ex.put(`/work-permits/${ids.pt}/answers/${ids.q2}`).send({ answer: 'YES' }).expect(200);
    await ex.post(`/work-permits/${ids.pt}/submit`).expect(200);
    expect((await ex.patch(`/work-permits/${ids.pt}`).send({ rowVersion: 4, location: 'outro' })).body.code).toBe('PT_NOT_EDITABLE');
  });

  it('quem criou não analisa; SST analisa e libera para aprovação', async () => {
    await (await api('execA')).post(`/work-permits/${ids.pt}/review`).send({ approve: true }).expect(403);
    await (await api('sstA')).post(`/work-permits/${ids.pt}/review`).send({ approve: true }).expect(200);
  });
});

describe('PT: liberação assinada', () => {
  it('não libera sem medição dos gases', async () => {
    const r = await (await api('supA1')).post(`/work-permits/${ids.pt}/release`).expect(422);
    expect(r.body.blocking.map((i: { code: string }) => i.code)).toEqual(['GAS_MISSING', 'GAS_MISSING']);
  });

  it('medição fora do limite impede a liberação', async () => {
    await measureAll([{ parameterKey: 'o2', value: 17 }, { parameterKey: 'lie', value: 0 }]);
    const r = await (await api('supA1')).post(`/work-permits/${ids.pt}/release`).expect(422);
    expect(r.body.blocking.map((i: { code: string }) => i.code)).toEqual(['GAS_OUT_OF_LIMITS']);
    await (await api('execA')).post(`/work-permits/${ids.pt}/measurements`).send({ parameterKey: 'h2s', value: 1, instrument: 'x' }).expect(400);
  });

  it('só libera quem tem papel, designação, MFA e login recente — e não é quem criou', async () => {
    await measureAll();
    await (await api('execA')).post(`/work-permits/${ids.pt}/release`).expect(403);
    const noDesignation = await (await api('sst2A')).post(`/work-permits/${ids.pt}/release`).expect(403);
    expect(noDesignation.body.message).toMatch(/designação/);
    expect((await (await api('supA1', { authAgeSeconds: 3600 })).post(`/work-permits/${ids.pt}/release`).expect(401)).body.code).toBe('REAUTH_REQUIRED');
    const ok = await (await api('supA1')).post(`/work-permits/${ids.pt}/release`).expect(200);
    expect(ok.body.status).toBe('RELEASED');
    expect(ok.body.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PT liberada vale como autorização', async () => {
    const v = (await (await api('auditA')).get(`/work-permits/${ids.pt}/validity`).expect(200)).body;
    expect(v).toMatchObject({ valid: true, status: 'RELEASED' });
  });
});

describe('PT: execução', () => {
  it('não inicia sem a ciência de toda a equipe', async () => {
    const r = await (await api('supA1')).post(`/work-permits/${ids.pt}/start`).expect(400);
    expect(r.body.message).toMatch(/Edson.*Silvia.*Sueli/);
    expect((await (await api('execA')).post(`/work-permits/${ids.pt}/entries`).send({ workerId: ids.w_exec }).expect(400)).body.code).toBe('ENTRY_NOT_ALLOWED');
  });

  it('cada integrante registra a própria ciência', async () => {
    await (await api('auditA')).post(`/work-permits/${ids.pt}/acknowledge`).expect(403);
    for (const u of ['execA', 'supA1', 'sst2A']) await (await api(u)).post(`/work-permits/${ids.pt}/acknowledge`).expect(200);
    expect((await (await api('execA')).post(`/work-permits/${ids.pt}/acknowledge`).expect(400)).body.code).toBe('ALREADY_ACKNOWLEDGED');
  });

  it('inicia e controla entradas', async () => {
    await (await api('supA1')).post(`/work-permits/${ids.pt}/start`).expect(200);
    const sup = await api('supA1');
    ids.entry = (await sup.post(`/work-permits/${ids.pt}/entries`).send({ workerId: ids.w_exec }).expect(201)).body.id;
    await sup.post(`/work-permits/${ids.pt}/entries`).send({ workerId: ids.w_exec }).expect(409);
    await sup.post(`/work-permits/${ids.pt}/entries`).send({ workerId: ids.w_terceiro }).expect(400);
  });

  it('medição fora do limite em execução suspende na hora; saída continua permitida', async () => {
    const r = await (await api('execA')).post(`/work-permits/${ids.pt}/measurements`).send({ parameterKey: 'o2', value: 18.2, instrument: 'Detector SN 0001' }).expect(201);
    expect(r.body).toMatchObject({ within_limits: false, suspended: true });
    const v = (await (await api('execA')).get(`/work-permits/${ids.pt}/validity`).expect(200)).body;
    expect(v.valid).toBe(false);
    expect((await (await api('supA1')).post(`/work-permits/${ids.pt}/entries`).send({ workerId: ids.w_sup }).expect(400)).body.code).toBe('ENTRY_NOT_ALLOWED');
    await (await api('execA')).post(`/work-permits/${ids.pt}/entries/${ids.entry}/exit`).expect(200);
    await (await api('execA')).post(`/work-permits/${ids.pt}/entries/${ids.entry}/exit`).expect(404);
  });

  it('retomada exige nova medição após a suspensão, assinatura e nova ciência', async () => {
    expect((await (await api('supA1')).post(`/work-permits/${ids.pt}/resume`).expect(422)).body.blocking[0].code).toBe('GAS_BEFORE_SUSPENSION');
    await measureAll();
    await (await api('supA1')).post(`/work-permits/${ids.pt}/resume`).expect(200);
    expect((await (await api('supA1')).post(`/work-permits/${ids.pt}/start`).expect(400)).body.code).toBe('ACK_MISSING');
    for (const u of ['execA', 'supA1', 'sst2A']) await (await api(u)).post(`/work-permits/${ids.pt}/acknowledge`).expect(200);
    await (await api('supA1')).post(`/work-permits/${ids.pt}/start`).expect(200);
  });

  it('qualquer integrante pode suspender, sem exigir login recente', async () => {
    const r = await (await api('sst2A', { authAgeSeconds: 7200 })).post(`/work-permits/${ids.pt}/suspend`).send({ reason: 'Chuva forte' });
    expect(r.status).toBe(200);
    await measureAll();
    await (await api('supA1')).post(`/work-permits/${ids.pt}/resume`).expect(200);
    for (const u of ['execA', 'supA1', 'sst2A']) await (await api(u)).post(`/work-permits/${ids.pt}/acknowledge`).expect(200);
    await (await api('supA1')).post(`/work-permits/${ids.pt}/start`).expect(200);
  });

  it('encerramento: sem ninguém dentro, com confirmações, por quem pode', async () => {
    const sup = await api('supA1');
    const e = (await sup.post(`/work-permits/${ids.pt}/entries`).send({ workerId: ids.w_exec }).expect(201)).body.id;
    const body = { areaReleased: true, teamOut: true, notes: 'Tanque limpo' };
    expect((await sup.post(`/work-permits/${ids.pt}/close`).send(body).expect(400)).body.code).toBe('PEOPLE_INSIDE');
    await sup.post(`/work-permits/${ids.pt}/entries/${e}/exit`).expect(200);
    await sup.post(`/work-permits/${ids.pt}/close`).send({ areaReleased: true }).expect(400);
    await (await api('execA')).post(`/work-permits/${ids.pt}/close`).send(body).expect(403);
    await sup.post(`/work-permits/${ids.pt}/close`).send(body).expect(200);
    expect((await sup.get(`/work-permits/${ids.pt}/validity`).expect(200)).body).toMatchObject({ valid: false, status: 'CLOSED' });
  });

  it('assinaturas íntegras e PT inalterada desde a última liberação', async () => {
    const r = (await (await api('auditA')).get(`/work-permits/${ids.pt}/signatures`).expect(200)).body;
    const meanings = r.signatures.map((s: { meaning: string }) => s.meaning);
    expect(meanings[0]).toBe('RELEASE');
    expect(meanings.filter((m: string) => m === 'RESUME')).toHaveLength(2);
    expect(meanings.filter((m: string) => m === 'ACKNOWLEDGE')).toHaveLength(9);
    expect(meanings).toContain('SUSPEND');
    expect(meanings.at(-1)).toBe('CLOSE');
    expect(r.signatures.every((s: { integrity: boolean }) => s.integrity)).toBe(true);
    expect(r.unchangedSinceRelease).toBe(true);
    const release = r.signatures[0];
    expect(release.evidence).toMatchObject({ mfa: true, method: 'OIDC_SESSION', sessionId: 'sessao-teste' });
  });

  it('o histórico registra a sequência, incluindo a suspensão automática', async () => {
    const h = (await (await api('auditA')).get(`/work-permits/${ids.pt}/history`).expect(200)).body.map((e: { action: string }) => e.action);
    expect(h[0]).toBe('pt.create');
    expect(h).toEqual(expect.arrayContaining(['pt.release', 'pt.acknowledge', 'pt.start', 'pt.entry', 'pt.suspend_auto', 'pt.exit', 'pt.resume', 'pt.suspend', 'pt.close']));
  });
});

describe('PT: expiração', () => {
  it('PT vencida passa a expirada e deixa de valer, sem depender de rotina externa', async () => {
    const id = await withContext(w.owner, { tenantId: A() }, async (tx) => (await tx.insertInto('work_permits').values({
      tenant_id: A(), number: 'PT-2026-000900', pt_type_id: ids.type!, apr_id: ids.apr!, unit_id: w.ids.unitA1!, location: 'x', description: 'x',
      starts_at: iso(-120), ends_at: iso(-1), status: 'RELEASED', released_by: w.ids.supA1!, created_by: w.ids.execA!,
    }).returning('id').executeTakeFirstOrThrow()).id);
    const r = (await (await api('execA')).get(`/work-permits/${id}`).expect(200)).body;
    expect(r.status).toBe('EXPIRED');
    expect(r.validity.valid).toBe(false);
    const h = (await (await api('auditA')).get(`/work-permits/${id}/history`).expect(200)).body.map((e: { action: string }) => e.action);
    expect(h).toEqual(['pt.expire']);
  });
});
