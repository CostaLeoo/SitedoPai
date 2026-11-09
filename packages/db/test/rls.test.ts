import { audit, createDb, Db, sql, withContext } from '../src';
import { APP_URL, Fixture, OWNER_URL, resetDatabase, seedFixture } from './helpers';

let owner: Db;
let app: Db;
let f: Fixture;

beforeAll(async () => {
  await resetDatabase();
  owner = createDb(OWNER_URL);
  app = createDb(APP_URL, { max: 40 });
  f = await seedFixture(owner);
});

afterAll(async () => {
  await owner.destroy();
  await app.destroy();
});

const A = () => ({ tenantId: f.tenantA, userId: f.userA });

describe('papel da aplicação', () => {
  it('não é superusuário nem ignora RLS', async () => {
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(app);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('isolamento entre empresas (RLS)', () => {
  it('sem contexto, nenhuma linha de cliente é visível', async () => {
    for (const t of ['units', 'sectors', 'memberships', 'role_assignments', 'audit_events'] as const) {
      const rows = await app.selectFrom(t).selectAll().execute();
      expect(rows).toHaveLength(0);
    }
  });

  it('a empresa A vê só as próprias unidades', async () => {
    const rows = await withContext(app, A(), (tx) => tx.selectFrom('units').select(['id', 'tenant_id']).execute());
    expect(rows.map((r) => r.id)).toEqual([f.unitA]);
  });

  it('a empresa A não lê unidade da B pelo id', async () => {
    const row = await withContext(app, A(), (tx) =>
      tx.selectFrom('units').selectAll().where('id', '=', f.unitB).executeTakeFirst());
    expect(row).toBeUndefined();
  });

  it('a empresa A não altera nem apaga unidade da B', async () => {
    const upd = await withContext(app, A(), (tx) =>
      tx.updateTable('units').set({ name: 'invadido' }).where('id', '=', f.unitB).executeTakeFirst());
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const del = await withContext(app, A(), (tx) =>
      tx.deleteFrom('units').where('id', '=', f.unitB).executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(0);
    const still = await withContext(app, { tenantId: f.tenantB }, (tx) =>
      tx.selectFrom('units').select('name').where('id', '=', f.unitB).executeTakeFirstOrThrow());
    expect(still.name).toBe('Planta B1');
  });

  it('a empresa A não insere linha com tenant_id da B', async () => {
    await expect(
      withContext(app, A(), (tx) =>
        tx.insertInto('units').values({ tenant_id: f.tenantB, name: 'x', code: 'X' }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('a empresa A não move a própria unidade para a B', async () => {
    await expect(
      withContext(app, A(), (tx) =>
        tx.updateTable('units').set({ tenant_id: f.tenantB }).where('id', '=', f.unitA).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('chave composta impede setor da A apontar para unidade da B', async () => {
    await expect(
      withContext(app, A(), (tx) =>
        tx.insertInto('sectors').values({ tenant_id: f.tenantA, unit_id: f.unitB, name: 'S' }).execute()),
    ).rejects.toThrow(/foreign key/);
  });

  it('usuários: a empresa A não enxerga usuários só da B', async () => {
    const emails = await withContext(app, A(), (tx) => tx.selectFrom('users').select('email').execute());
    expect(emails.map((e) => e.email)).toEqual(['ana@alfa.test']);
  });

  it('sem empresa ativa, o usuário vê só os próprios vínculos', async () => {
    const rows = await withContext(app, { userId: f.userA }, (tx) =>
      tx.selectFrom('memberships').select('tenant_id').execute());
    expect(rows.map((r) => r.tenant_id)).toEqual([f.tenantA]);
    const tenants = await withContext(app, { userId: f.userA }, (tx) =>
      tx.selectFrom('tenants').select('id').execute());
    expect(tenants.map((t) => t.id)).toEqual([f.tenantA]);
  });

  it('contexto com valor inválido é recusado antes de ir ao banco', async () => {
    await expect(withContext(app, { tenantId: "x' OR 1=1" }, async () => 1)).rejects.toThrow(/inválido/);
  });
});

describe('funções privilegiadas', () => {
  it('invite_user exige empresa ativa', async () => {
    await expect(sql`SELECT invite_user('x@y.test', 'X')`.execute(app)).rejects.toThrow(/empresa ativa/);
  });

  it('platform_list_tenants recusa quem não é admin da plataforma', async () => {
    await expect(
      withContext(app, { userId: f.userA }, (tx) => sql`SELECT * FROM platform_list_tenants()`.execute(tx)),
    ).rejects.toThrow(/plataforma/);
  });

  it('platform_list_tenants devolve só dados comerciais ao admin', async () => {
    const r = await withContext(app, { userId: f.admin }, (tx) =>
      sql<Record<string, unknown>>`SELECT * FROM platform_list_tenants()`.execute(tx));
    expect(r.rows).toHaveLength(2);
    expect(Object.keys(r.rows[0]!).sort()).toEqual(['cnpj', 'created_at', 'id', 'legal_name', 'status', 'trade_name']);
  });

  it('admin da plataforma não lê unidades de clientes', async () => {
    const rows = await withContext(app, { userId: f.admin }, (tx) => tx.selectFrom('units').selectAll().execute());
    expect(rows).toHaveLength(0);
  });

  it('auth_resolve_user só vincula convite com e-mail verificado', async () => {
    await withContext(app, A(), (tx) => sql`SELECT invite_user('novo@alfa.test', 'Novo')`.execute(tx));
    const unverified = await sql<{ id: string | null }>`SELECT auth_resolve_user('sub-novo', 'novo@alfa.test', false) AS id`.execute(app);
    expect(unverified.rows[0]!.id).toBeNull();
    const verified = await sql<{ id: string | null }>`SELECT auth_resolve_user('sub-novo', 'NOVO@alfa.test', true) AS id`.execute(app);
    expect(verified.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    const other = await sql<{ id: string | null }>`SELECT auth_resolve_user('sub-outro', 'novo@alfa.test', true) AS id`.execute(app);
    expect(other.rows[0]!.id).toBeNull();
  });
});

describe('trilha de auditoria', () => {
  it('encadeia eventos e verifica a cadeia', async () => {
    await withContext(app, A(), async (tx) => {
      await audit(tx, f.tenantA, { actorUserId: f.userA, action: 'unit.create', entityType: 'unit', entityId: f.unitA });
      await audit(tx, f.tenantA, { actorUserId: f.userA, action: 'unit.update', entityType: 'unit', entityId: f.unitA, data: { name: 'x' } });
    });
    const rows = await withContext(app, A(), (tx) =>
      tx.selectFrom('audit_events').select(['seq', 'prev_hash', 'hash']).orderBy('seq').execute());
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2]);
    expect(rows[0]!.prev_hash).toBe('0'.repeat(64));
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    const v = await withContext(app, A(), (tx) => sql<{ broken: string | null }>`SELECT audit_verify() AS broken`.execute(tx));
    expect(v.rows[0]!.broken).toBeNull();
  });

  it('não permite UPDATE, DELETE nem TRUNCATE', async () => {
    await expect(withContext(app, A(), (tx) => tx.updateTable('audit_events').set({ action: 'x' } as never).execute())).rejects.toThrow();
    await expect(withContext(app, A(), (tx) => tx.deleteFrom('audit_events').execute())).rejects.toThrow();
    await expect(withContext(app, A(), (tx) => sql`TRUNCATE audit_events`.execute(tx))).rejects.toThrow();
    // Nem o dono do schema altera sem desligar o gatilho explicitamente.
    await sql`ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY`.execute(owner);
    try {
      await expect(owner.updateTable('audit_events').set({ action: 'x' } as never).execute()).rejects.toThrow(/somente inserção/);
    } finally {
      await sql`ALTER TABLE audit_events FORCE ROW LEVEL SECURITY`.execute(owner);
    }
  });

  it('não grava evento em nome de outra empresa', async () => {
    await expect(
      withContext(app, A(), (tx) => audit(tx, f.tenantB, { actorUserId: f.userA, action: 'x', entityType: 'x' })),
    ).rejects.toThrow(/row-level security/);
  });

  it('mantém a sequência contínua com 30 gravações concorrentes', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        withContext(app, { tenantId: f.tenantB, userId: f.userB }, (tx) =>
          audit(tx, f.tenantB, { actorUserId: f.userB, action: 'concurrency', entityType: 'test', entityId: String(i) }))),
    );
    const seqs = await withContext(app, { tenantId: f.tenantB }, (tx) =>
      tx.selectFrom('audit_events').select('seq').orderBy('seq').execute());
    expect(seqs.map((s) => Number(s.seq))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const v = await withContext(app, { tenantId: f.tenantB }, (tx) => sql<{ broken: string | null }>`SELECT audit_verify() AS broken`.execute(tx));
    expect(v.rows[0]!.broken).toBeNull();
  });

  it('a verificação detecta adulteração', async () => {
    // Simula um invasor com acesso de dono: desliga proteções, altera um evento e religa.
    await sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`.execute(owner);
    await sql`ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY`.execute(owner);
    try {
      const r = await sql`UPDATE audit_events SET data = '{"adulterado":true}' WHERE tenant_id = ${f.tenantB} AND seq = 7`.execute(owner);
      expect(Number(r.numAffectedRows)).toBe(1);
    } finally {
      await sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`.execute(owner);
      await sql`ALTER TABLE audit_events FORCE ROW LEVEL SECURITY`.execute(owner);
    }
    const v = await withContext(app, { tenantId: f.tenantB }, (tx) => sql<{ broken: string | null }>`SELECT audit_verify() AS broken`.execute(tx));
    expect(Number(v.rows[0]!.broken)).toBe(7);
  });
});
