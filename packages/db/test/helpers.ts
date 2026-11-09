import { Client } from 'pg';
import { createDb, migrate, withContext, Db } from '../src';

export const OWNER_URL =
  process.env.TEST_DATABASE_OWNER_URL ?? 'postgresql://sitedopai_owner:dev_owner_pw@localhost:5432/sitedopai_test';
export const APP_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://sitedopai_app:dev_app_pw@localhost:5432/sitedopai_test';

/** Apaga e recria o schema do banco de teste, e aplica as migrações. */
export async function resetDatabase(): Promise<void> {
  const c = new Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO sitedopai_app;');
  await c.end();
  await migrate(OWNER_URL);
}

export interface Fixture {
  tenantA: string;
  tenantB: string;
  unitA: string;
  unitB: string;
  userA: string;
  userB: string;
  admin: string;
}

/** Dados fictícios mínimos: duas empresas, uma unidade e um usuário em cada. */
export async function seedFixture(owner: Db): Promise<Fixture> {
  const [ta, tb] = await owner
    .insertInto('tenants')
    .values([
      { legal_name: 'Alfa Indústria Ltda (fictícia)', trade_name: 'Alfa', cnpj: '11111111000191' },
      { legal_name: 'Beta Construções Ltda (fictícia)', trade_name: 'Beta', cnpj: '22222222000182' },
    ])
    .returning('id')
    .execute();
  const [ua, ub, ad] = await owner
    .insertInto('users')
    .values([
      { email: 'ana@alfa.test', display_name: 'Ana (fictícia)', oidc_subject: 'sub-ana' },
      { email: 'bruno@beta.test', display_name: 'Bruno (fictício)', oidc_subject: 'sub-bruno' },
      { email: 'plataforma@sitedopai.test', display_name: 'Admin plataforma', oidc_subject: 'sub-plat' },
    ])
    .returning('id')
    .execute();
  await owner.insertInto('platform_admins').values({ user_id: ad!.id }).execute();

  const mk = async (tenantId: string, userId: string, code: string) =>
    withContext(owner, { tenantId }, async (tx) => {
      const u = await tx.insertInto('units').values({ tenant_id: tenantId, name: `Planta ${code}`, code }).returning('id').executeTakeFirstOrThrow();
      const m = await tx.insertInto('memberships').values({ tenant_id: tenantId, user_id: userId, status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('role_assignments').values({ tenant_id: tenantId, membership_id: m.id, role: 'COMPANY_ADMIN', scope_type: 'TENANT' }).execute();
      return u.id;
    });
  const unitA = await mk(ta!.id, ua!.id, 'A1');
  const unitB = await mk(tb!.id, ub!.id, 'B1');
  return { tenantA: ta!.id, tenantB: tb!.id, unitA, unitB, userA: ua!.id, userB: ub!.id, admin: ad!.id };
}

export { createDb };
