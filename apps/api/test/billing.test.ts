import { createHmac } from 'node:crypto';
import { unzipSync } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createDb, withContext } from '@sitedopai/db';
import { APP_URL } from '../../../packages/db/test/helpers';
import { loadConfig } from '../src/config';
import { createWorld, destroyWorld, token, WEBHOOK_SECRET, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;
let platform: string;
let adminA: string;
let planId: string;
let subRef: string;
const A = () => w.ids.alfa!;
const asA = (r: request.Test) => r.set('Authorization', adminA).set('X-Tenant-Id', A());
const asP = (r: request.Test) => r.set('Authorization', platform);
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
};
const sign = (body: string, at = Math.floor(Date.now() / 1000)) =>
  `t=${at},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${at}.${body}`).digest('hex')}`;
const hook = (ev: Record<string, unknown>, sig?: string) => {
  const body = JSON.stringify({ eventId: `evt_${randomUUID()}`, subscriptionRef: subRef, ...ev });
  return http.post('/billing/webhooks/simulated').set('Content-Type', 'application/json').set('X-Signature', sig ?? sign(body)).send(body);
};
const tenantStatus = async () => (await withContext(w.owner, { tenantId: A() }, (tx) =>
  tx.selectFrom('tenants').select('status').where('id', '=', A()).executeTakeFirstOrThrow())).status;

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  platform = `Bearer ${await token({ sub: 'sub-platform' })}`;
  adminA = `Bearer ${await token({ sub: 'sub-adminA' })}`;
});
afterAll(async () => destroyWorld(w));

describe('planos', () => {
  it('só o administrador da plataforma cria; o banco também impede', async () => {
    await asA(http.post('/platform/plans')).send({ code: 'x', name: 'X', priceCents: 100, maxUsers: null, maxUnits: null }).expect(403);
    const p = (await asP(http.post('/platform/plans')).send({ code: 'basico', name: 'Básico (teste)', priceCents: 19900, maxUsers: 50, maxUnits: 2 }).expect(201)).body;
    planId = p.id;
    expect(p).toMatchObject({ priceCents: 19900, maxUnits: 2, active: true });
    await asP(http.post('/platform/plans')).send({ code: 'Inválido!', name: 'X', priceCents: 100, maxUsers: null, maxUnits: null }).expect(400);
    // Papel da aplicação, sem ser administrador da plataforma: o banco recusa.
    const app = createDb(APP_URL);
    await expect(withContext(app, { userId: w.ids.adminA }, (tx) =>
      tx.insertInto('plans').values({ code: 'pirata', name: 'P', price_cents: 1, created_by: w.ids.adminA! }).execute())).rejects.toThrow();
    await app.destroy();
  });
});

describe('assinatura e situação da empresa', () => {
  it('contrata com tolerância informada; limite de unidades passa a valer', async () => {
    await asP(http.post(`/platform/tenants/${A()}/subscription`)).send({ planId }).expect(400); // tolerância é obrigatória
    const s = (await asP(http.post(`/platform/tenants/${A()}/subscription`)).send({ planId, graceDays: 5 }).expect(201)).body;
    subRef = s.provider_subscription_ref;
    expect(s).toMatchObject({ plan_name: 'Básico (teste)', price_cents: 19900, grace_days: 5, status: 'ACTIVE' });
    await asP(http.post(`/platform/tenants/${A()}/subscription`)).send({ planId, graceDays: 5 }).expect(409);
    const r = await asA(http.post('/units')).send({ name: 'Terceira', code: 'A3' }).expect(402);
    expect(r.body.code).toBe('PLAN_LIMIT');
  });

  it('webhook sem assinatura válida, vencido ou adulterado é recusado', async () => {
    await hook({ type: 'charge.created', chargeRef: 'c0', amountCents: 19900, dueDate: day(10) }, 't=1,v1=00').expect(400);
    const body = JSON.stringify({ eventId: 'e-old', subscriptionRef: subRef, type: 'charge.created', chargeRef: 'c0', amountCents: 19900, dueDate: day(10) });
    await http.post('/billing/webhooks/simulated').set('Content-Type', 'application/json').set('X-Signature', sign(body, Math.floor(Date.now() / 1000) - 3600)).send(body).expect(400);
    await http.post('/billing/webhooks/simulated').set('Content-Type', 'application/json').set('X-Signature', sign(body)).send(body.replace('19900', '1')).expect(400);
    await http.post('/billing/webhooks/outro').set('Content-Type', 'application/json').send(body).expect(404);
  });

  it('atraso dentro da tolerância: GRACE_PERIOD, tudo continua funcionando', async () => {
    const r = await hook({ type: 'charge.created', chargeRef: 'c1', amountCents: 19900, dueDate: day(-3) }).expect(200);
    expect(r.body).toMatchObject({ accepted: true, tenantStatus: 'GRACE_PERIOD' });
    await asA(http.post('/units/' + w.ids.unitA1 + '/sectors')).send({ name: 'Elétrica' }).expect(201);
  });

  it('o mesmo aviso duas vezes é processado uma vez só', async () => {
    const body = JSON.stringify({ eventId: 'evt-dup', subscriptionRef: subRef, type: 'charge.failed', chargeRef: 'c1', failureReason: 'Cartão recusado' });
    const send = () => http.post('/billing/webhooks/simulated').set('Content-Type', 'application/json').set('X-Signature', sign(body)).send(body).expect(200);
    expect((await send()).body.duplicate).toBeUndefined();
    expect((await send()).body.duplicate).toBe(true);
  });

  it('além da tolerância: SOMENTE LEITURA, mas segurança da PT, PDF e exportação continuam', async () => {
    const r = await hook({ type: 'charge.created', chargeRef: 'c2', amountCents: 19900, dueDate: day(-10) }).expect(200);
    expect(r.body.tenantStatus).toBe('READ_ONLY');
    const blocked = await asA(http.post('/units/' + w.ids.unitA1 + '/sectors')).send({ name: 'Bloqueado' }).expect(403);
    expect(blocked.body.code).toBe('TENANT_READ_ONLY');
    await asA(http.get('/units')).expect(200);
    // Ações de segurança passam pelo bloqueio comercial (aqui: PT inexistente → 404, não 403).
    const fake = randomUUID();
    for (const path of [`/work-permits/${fake}/suspend`, `/work-permits/${fake}/entries/${fake}/exit`, `/work-permits/${fake}/measurements`,
      `/work-permits/${fake}/entries`, `/work-permits/${fake}/close`]) {
      const res = await asA(http.post(path)).send({});
      expect(res.body.code).not.toBe('TENANT_READ_ONLY');
    }
    // Liberar e retomar PT: bloqueados.
    expect((await asA(http.post(`/work-permits/${fake}/release`)).send({})).body.code).toBe('TENANT_READ_ONLY');
    expect((await asA(http.post(`/work-permits/${fake}/resume`)).send({})).body.code).toBe('TENANT_READ_ONLY');
    await asA(http.post('/exports')).expect(200);
  });

  it('pagamento das cobranças em atraso volta para ATIVA', async () => {
    await hook({ type: 'charge.paid', chargeRef: 'c2', paidAt: new Date().toISOString(), receiptUrl: 'https://provedor.exemplo.test/r/2', periodEnd: day(20) }).expect(200);
    // Resta a c1 (vencida há 3 dias, dentro da tolerância de 5).
    expect(await tenantStatus()).toBe('GRACE_PERIOD');
    const r = await hook({ type: 'charge.paid', chargeRef: 'c1', paidAt: new Date().toISOString() }).expect(200);
    expect(r.body.tenantStatus).toBe('ACTIVE');
    await hook({ type: 'charge.failed', chargeRef: 'c1' }).expect(200);
    const inv = await withContext(w.owner, { tenantId: A() }, (tx) => tx.selectFrom('invoices').select(['provider_charge_ref', 'status']).orderBy('provider_charge_ref').execute());
    expect(inv).toEqual([{ provider_charge_ref: 'c1', status: 'PAID' }, { provider_charge_ref: 'c2', status: 'PAID' }]);
  });

  it('cobrança e assinatura não podem ser alteradas nem apagadas no banco', async () => {
    await expect(withContext(w.owner, { tenantId: A() }, (tx) => tx.updateTable('invoices').set({ amount_cents: 1 }).execute())).rejects.toThrow();
    await expect(withContext(w.owner, { tenantId: A() }, (tx) => tx.deleteFrom('invoices').execute())).rejects.toThrow();
    await expect(withContext(w.owner, { tenantId: A() }, (tx) => tx.updateTable('subscriptions').set({ price_cents: 1 }).execute())).rejects.toThrow();
    await expect(withContext(w.owner, { tenantId: A() }, (tx) => tx.deleteFrom('billing_events').execute())).rejects.toThrow();
  });

  it('a empresa vê a própria cobrança (só o administrador) e nenhum dado de cartão', async () => {
    const r = (await asA(http.get('/billing')).expect(200)).body;
    expect(r.subscription).toMatchObject({ plan_name: 'Básico (teste)', status: 'ACTIVE' });
    expect(r.invoices).toHaveLength(2);
    expect(r.invoices.find((i: { receipt_url: string | null }) => i.receipt_url)).toBeDefined();
    expect(JSON.stringify(r)).not.toMatch(/card|cartao|provider_customer/i);
    const sup = `Bearer ${await token({ sub: 'sub-supA1' })}`;
    await http.get('/billing').set('Authorization', sup).set('X-Tenant-Id', A()).expect(403);
  });

  it('visão da plataforma: dados comerciais e contagens, sem conteúdo', async () => {
    const rows = (await asP(http.get('/platform/billing/overview')).expect(200)).body as Record<string, unknown>[];
    const beta = rows.find((x) => x.tenant_id === w.ids.beta)!;
    expect(beta).toMatchObject({ aprs: '1', work_permits: '1', subscription_id: null });
    const text = JSON.stringify(rows);
    for (const secret of ['Segredo da Beta', 'Telhado Beta', 'Tanque Beta', 'Trabalhador Beta']) expect(text).not.toContain(secret);
    await asA(http.get('/platform/billing/overview')).expect(403);
  });

  it('cancelamento: somente leitura, nada é apagado; encerrada continua exportando', async () => {
    const before = await withContext(w.owner, { tenantId: A() }, (tx) => tx.selectFrom('units').select('id').execute());
    await asP(http.post(`/platform/tenants/${A()}/subscription/cancel`)).send({ reason: 'Fim de contrato (teste)' }).expect(200);
    expect(await tenantStatus()).toBe('ACTIVE'); // período pago até day(20)
    await asP(http.post(`/platform/tenants/${A()}/status`)).send({ status: 'CLOSED', reason: 'Contrato encerrado (teste)' }).expect(200);
    await asA(http.get('/units')).expect(200);
    await asA(http.post('/units')).send({ name: 'X', code: 'X1' }).expect(403);
    const zip = await asA(http.post('/exports')).buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    }).expect(200);
    const files = unzipSync(new Uint8Array(zip.body as Buffer));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['LEIA-ME.txt', 'manifesto.json', 'dados/unidades.json', 'dados/aprs.csv', 'dados/auditoria.json']));
    const after = await withContext(w.owner, { tenantId: A() }, (tx) => tx.selectFrom('units').select('id').execute());
    expect(after).toHaveLength(before.length);
    // A sincronização nunca tira do ENCERRADO sozinha.
    await asP(http.post('/platform/billing/sync')).expect(200);
    expect(await tenantStatus()).toBe('CLOSED');
  });
});

describe('exportação', () => {
  it('traz PDFs, fotos originais e manifesto com hashes; CSV protegido contra fórmula', async () => {
    const adminB = `Bearer ${await token({ sub: 'sub-adminB' })}`;
    const asB = (r: request.Test) => r.set('Authorization', adminB).set('X-Tenant-Id', w.ids.beta!);
    await asB(http.post(`/aprs/${w.ids.aprB}/documents`)).expect(201);
    await withContext(w.owner, { tenantId: w.ids.beta }, (tx) => tx.updateTable('work_permits').set({ description: '=HYPERLINK("x")' }).where('id', '=', w.ids.ptB!).execute());
    const res = await asB(http.post('/exports')).buffer(true).parse((r, cb) => {
      const c: Buffer[] = [];
      r.on('data', (d: Buffer) => c.push(d));
      r.on('end', () => cb(null, Buffer.concat(c)));
    }).expect(200);
    const buf = res.body as Buffer;
    expect(res.headers['x-content-sha256']).toBe(createHash('sha256').update(buf).digest('hex'));
    const files = unzipSync(new Uint8Array(buf));
    expect(Object.keys(files).some((k) => /^documentos\/APR-2026-000001-emissao1\.pdf$/.test(k))).toBe(true);
    expect(Object.keys(files).some((k) => k.startsWith('fotos/APR-2026-000001/'))).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifesto.json']));
    for (const f of manifest.arquivos) expect(createHash('sha256').update(files[f.path]!).digest('hex')).toBe(f.sha256);
    expect(new TextDecoder().decode(files['dados/pts.csv'])).toContain(`'=HYPERLINK`);
    const ev = (await asB(http.get('/audit-events')).expect(200)).body as { action: string }[];
    expect(ev.some((e) => e.action === 'tenant.export')).toBe(true);
    const sup = `Bearer ${await token({ sub: 'sub-supA1' })}`;
    await http.post('/exports').set('Authorization', sup).set('X-Tenant-Id', A()).expect(403);
  });
});

describe('área da plataforma', () => {
  it('administrador de empresa recebe 403 em todas as rotas /platform', async () => {
    const id = randomUUID();
    const routes: [string, string][] = [['get', '/platform/plans'], ['post', '/platform/plans'], ['patch', `/platform/plans/${id}`],
      ['get', '/platform/billing/overview'], ['get', `/platform/tenants/${A()}/billing`], ['post', `/platform/tenants/${A()}/subscription`],
      ['post', `/platform/tenants/${A()}/subscription/cancel`], ['post', `/platform/tenants/${A()}/status`], ['post', '/platform/billing/sync'],
      ['post', '/platform/billing/simulate']];
    for (const [m, path] of routes) {
      const res = await (http as unknown as Record<string, (p: string) => request.Test>)[m]!(path).set('Authorization', adminA).set('X-Tenant-Id', A()).send({});
      expect(`${m} ${path} ${res.status}`).toBe(`${m} ${path} 403`);
    }
  });
});

describe('configuração', () => {
  it('provedor simulado é recusado em produção', () => {
    const base = { DATABASE_URL: 'postgresql://x@localhost/x', OIDC_ISSUER: 'https://idp.test/realms/x', OIDC_AUDIENCE: 'api', NODE_ENV: 'production' };
    expect(() => loadConfig(base)).toThrow(/BILLING_PROVIDER=simulated/);
  });
});
