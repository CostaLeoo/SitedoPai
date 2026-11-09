import request from 'supertest';
import { createWorld, destroyWorld, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
});
afterAll(async () => destroyWorld(w));

const as = async (user: string, opts: { mfa?: boolean } = {}) =>
  `Bearer ${await token({ sub: `sub-${user}`, mfa: opts.mfa })}`;

describe('autenticação', () => {
  it('health check é público', async () => {
    await http.get('/health').expect(200, { status: 'ok' });
  });

  it.each([
    ['sem token', undefined],
    ['cabeçalho malformado', 'Token abc'],
    ['lixo no lugar do JWT', 'Bearer nao.e.jwt'],
  ])('recusa %s', async (_, header) => {
    const req = http.get('/me');
    if (header) req.set('Authorization', header);
    const res = await req.expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['assinado por outra chave', { key: 'other' as const }],
    ['expirado', { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
    ['de outro emissor', { issuer: 'https://evil.test/realms/x' }],
    ['para outro público', { audience: 'outro-app' }],
  ])('recusa token %s', async (_, o) => {
    const t = await token({ sub: 'sub-adminA', ...o });
    await http.get('/me').set('Authorization', `Bearer ${t}`).expect(401);
  });

  it('recusa token sem assinatura (alg none)', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none' })}.${b64({ sub: 'sub-adminA', iss: 'https://idp.test/realms/sitedopai', aud: 'sitedopai-api', exp: 9999999999 })}.`;
    await http.get('/me').set('Authorization', `Bearer ${unsigned}`).expect(401);
  });

  it('usuário autenticado mas não convidado recebe 403', async () => {
    const t = await token({ sub: 'sub-estranho', email: 'estranho@exemplo.test' });
    const res = await http.get('/me').set('Authorization', `Bearer ${t}`).expect(403);
    expect(res.body.code).toBe('NOT_INVITED');
  });
});

describe('sessão e seleção de empresa', () => {
  it('/me lista só as empresas do usuário', async () => {
    const res = await http.get('/me').set('Authorization', await as('adminA')).expect(200);
    expect(res.body.tenants.map((t: { tenantId: string }) => t.tenantId)).toEqual([w.ids.alfa]);
    expect(res.body.user.mfa).toBe(true);
  });

  it('exige X-Tenant-Id nas rotas de empresa', async () => {
    const res = await http.get('/units').set('Authorization', await as('adminA')).expect(400);
    expect(res.body.code).toBe('TENANT_REQUIRED');
  });

  it.each([
    ['de outra empresa', () => w.ids.beta],
    ['inexistente', () => '00000000-0000-4000-8000-000000000000'],
  ])('recusa empresa %s com a mesma resposta', async (_, tenant) => {
    const res = await http.get('/units').set('Authorization', await as('adminA')).set('X-Tenant-Id', tenant()!).expect(403);
    expect(res.body.code).toBe('NO_ACCESS');
  });
});

describe('MFA para perfis privilegiados', () => {
  it('administrador sem segundo fator é bloqueado', async () => {
    const res = await http.get('/units').set('Authorization', await as('adminA', { mfa: false })).set('X-Tenant-Id', w.ids.alfa!).expect(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });

  it('supervisor e auditor sem segundo fator também', async () => {
    for (const u of ['supA1', 'auditA']) {
      await http.get('/units').set('Authorization', await as(u, { mfa: false })).set('X-Tenant-Id', w.ids.alfa!).expect(403);
    }
  });

  it('executante sem segundo fator pode acessar', async () => {
    await http.get('/units').set('Authorization', await as('execA', { mfa: false })).set('X-Tenant-Id', w.ids.alfa!).expect(200);
  });
});

describe('permissões e escopo', () => {
  const A = () => w.ids.alfa!;

  it('executante não cria unidade', async () => {
    const res = await http.post('/units').set('Authorization', await as('execA')).set('X-Tenant-Id', A())
      .send({ name: 'X', code: 'X' }).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('supervisor da A1 só enxerga a A1', async () => {
    const auth = await as('supA1');
    const list = await http.get('/units').set('Authorization', auth).set('X-Tenant-Id', A()).expect(200);
    expect(list.body.map((u: { id: string }) => u.id)).toEqual([w.ids.unitA1]);
    await http.get(`/units/${w.ids.unitA2}`).set('Authorization', auth).set('X-Tenant-Id', A()).expect(404);
    await http.get(`/units/${w.ids.unitA1}`).set('Authorization', auth).set('X-Tenant-Id', A()).expect(200);
  });

  it('supervisor não cria setor (só admin e SST)', async () => {
    await http.post(`/units/${w.ids.unitA1}/sectors`).set('Authorization', await as('supA1')).set('X-Tenant-Id', A())
      .send({ name: 'Elétrica' }).expect(403);
  });

  it('executante não lê vínculos nem auditoria', async () => {
    const auth = await as('execA');
    await http.get('/memberships').set('Authorization', auth).set('X-Tenant-Id', A()).expect(403);
    await http.get('/audit-events').set('Authorization', auth).set('X-Tenant-Id', A()).expect(403);
  });

  it('auditor lê auditoria mas não altera vínculos', async () => {
    const auth = await as('auditA');
    await http.get('/audit-events').set('Authorization', auth).set('X-Tenant-Id', A()).expect(200);
    await http.patch(`/memberships/${w.ids.m_execA}`).set('Authorization', auth).set('X-Tenant-Id', A())
      .send({ status: 'SUSPENDED' }).expect(403);
  });
});

describe('unidades', () => {
  const A = () => w.ids.alfa!;

  it('valida a entrada com mensagens por campo', async () => {
    const res = await http.post('/units').set('Authorization', await as('adminA')).set('X-Tenant-Id', A())
      .send({ name: '', code: 'Z', state: 'sao paulo' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fields.map((f: { field: string }) => f.field).sort()).toEqual(['name', 'state']);
  });

  it('cria, altera e registra na auditoria', async () => {
    const auth = await as('adminA');
    const created = await http.post('/units').set('Authorization', auth).set('X-Tenant-Id', A())
      .send({ name: 'Planta Hortolândia', code: 'A3', state: 'SP' }).expect(201);
    await http.patch(`/units/${created.body.id}`).set('Authorization', auth).set('X-Tenant-Id', A())
      .send({ name: 'Planta Hortolândia II' }).expect(200);
    const events = await http.get('/audit-events').set('Authorization', auth).set('X-Tenant-Id', A()).expect(200);
    const actions = events.body.filter((e: { entity_id: string }) => e.entity_id === created.body.id).map((e: { action: string }) => e.action);
    expect(actions).toEqual(['unit.create', 'unit.update']);
  });

  it('dois cadastros simultâneos com o mesmo código: um entra, o outro recebe 409', async () => {
    const auth = await as('adminA');
    const send = () => http.post('/units').set('Authorization', auth).set('X-Tenant-Id', A()).send({ name: 'Dup', code: 'DUP' });
    const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('o mesmo código pode existir em outra empresa', async () => {
    await http.post('/units').set('Authorization', await as('adminB')).set('X-Tenant-Id', w.ids.beta!)
      .send({ name: 'Outra', code: 'A1' }).expect(201);
  });
});

describe('empresa em modo somente leitura', () => {
  it('permite consultar e bloqueia escrita', async () => {
    const auth = await as('adminC');
    await http.get('/units').set('Authorization', auth).set('X-Tenant-Id', w.ids.gama!).expect(200);
    const res = await http.post('/units').set('Authorization', auth).set('X-Tenant-Id', w.ids.gama!)
      .send({ name: 'Nova', code: 'N' }).expect(403);
    expect(res.body.code).toBe('TENANT_READ_ONLY');
  });
});

describe('convites e vínculos', () => {
  const A = () => w.ids.alfa!;

  it('convidado entra no primeiro login com e-mail verificado', async () => {
    await http.post('/memberships').set('Authorization', await as('adminA')).set('X-Tenant-Id', A())
      .send({ email: 'Carla@Exemplo.test', displayName: 'Carla (fictícia)', roles: [{ role: 'EXECUTOR', unitId: w.ids.unitA2 }] })
      .expect(201);

    const notVerified = await token({ sub: 'sub-carla', email: 'carla@exemplo.test', emailVerified: false });
    await http.get('/me').set('Authorization', `Bearer ${notVerified}`).expect(403);

    const verified = `Bearer ${await token({ sub: 'sub-carla', email: 'carla@exemplo.test' })}`;
    const units = await http.get('/units').set('Authorization', verified).set('X-Tenant-Id', A()).expect(200);
    expect(units.body.map((u: { id: string }) => u.id)).toEqual([w.ids.unitA2]);

    const members = await http.get('/memberships').set('Authorization', await as('adminA')).set('X-Tenant-Id', A()).expect(200);
    expect(members.body.find((m: { email: string }) => m.email === 'carla@exemplo.test').status).toBe('ACTIVE');
  });

  it('não aceita papel com unidade de outra empresa', async () => {
    const res = await http.post('/memberships').set('Authorization', await as('adminA')).set('X-Tenant-Id', A())
      .send({ email: 'dani@exemplo.test', displayName: 'Dani', roles: [{ role: 'SUPERVISOR', unitId: w.ids.unitB1 }] })
      .expect(400);
    expect(res.body.code).toBe('INVALID_REFERENCE');
  });

  it('não aceita administrador restrito a uma unidade', async () => {
    await http.post('/memberships').set('Authorization', await as('adminA')).set('X-Tenant-Id', A())
      .send({ email: 'edu@exemplo.test', displayName: 'Edu', roles: [{ role: 'COMPANY_ADMIN', unitId: w.ids.unitA1 }] })
      .expect(400);
  });

  it('administrador não suspende o próprio acesso', async () => {
    const res = await http.patch(`/memberships/${w.ids.m_adminA}`).set('Authorization', await as('adminA')).set('X-Tenant-Id', A())
      .send({ status: 'SUSPENDED' }).expect(400);
    expect(res.body.code).toBe('SELF_CHANGE');
  });

  it('vínculo suspenso perde o acesso', async () => {
    await http.patch(`/memberships/${w.ids.m_execA}`).set('Authorization', await as('adminA')).set('X-Tenant-Id', A())
      .send({ status: 'SUSPENDED' }).expect(200);
    await http.get('/units').set('Authorization', await as('execA')).set('X-Tenant-Id', A()).expect(403);
  });
});

describe('administração da plataforma', () => {
  it('administrador de empresa não acessa a área da plataforma', async () => {
    await http.get('/platform/tenants').set('Authorization', await as('adminA')).expect(403);
  });

  it('exige MFA do administrador da plataforma', async () => {
    const res = await http.get('/platform/tenants').set('Authorization', await as('platform', { mfa: false })).expect(403);
    expect(res.body.code).toBe('MFA_REQUIRED');
  });

  it('lista só dados comerciais', async () => {
    const res = await http.get('/platform/tenants').set('Authorization', await as('platform')).expect(200);
    expect(res.body).toHaveLength(3);
    expect(Object.keys(res.body[0]).sort()).toEqual(['cnpj', 'created_at', 'id', 'legal_name', 'status', 'trade_name']);
  });

  it('não lê conteúdo de clientes', async () => {
    const res = await http.get('/units').set('Authorization', await as('platform')).set('X-Tenant-Id', w.ids.alfa!).expect(403);
    expect(res.body.code).toBe('NO_ACCESS');
  });

  it('cadastra empresa e convida o primeiro administrador', async () => {
    const auth = await as('platform');
    await http.post('/platform/tenants').set('Authorization', auth)
      .send({ legalName: 'Delta', cnpj: '11.111.111/0001-00', admin: { email: 'x@delta.test', displayName: 'X' } }).expect(400);
    const created = await http.post('/platform/tenants').set('Authorization', auth)
      .send({ legalName: 'Delta Montagens Ltda (fictícia)', cnpj: '44.444.444/0001-91', admin: { email: 'admin@delta.test', displayName: 'Admin Delta' } })
      .expect(201);
    const t = `Bearer ${await token({ sub: 'sub-delta', email: 'admin@delta.test' })}`;
    await http.get('/units').set('Authorization', t).set('X-Tenant-Id', created.body.id).expect(200);
  });
});

describe('auditoria', () => {
  it('a cadeia da empresa continua íntegra depois de todos os testes', async () => {
    const res = await http.get('/audit-events/verify').set('Authorization', await as('auditA')).set('X-Tenant-Id', w.ids.alfa!).expect(200);
    expect(res.body.intact).toBe(true);
    expect(res.body.events).toBeGreaterThan(3);
  });
});
