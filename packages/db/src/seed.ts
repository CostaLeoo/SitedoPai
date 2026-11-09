/**
 * Dados FICTÍCIOS para demonstração local. Nunca use dados reais de trabalhadores.
 * Os e-mails batem com os usuários do realm de desenvolvimento do Keycloak
 * (infra/keycloak/realm-sitedopai.json).
 */
import { createDb, withContext } from './index';

async function main() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('Defina DATABASE_OWNER_URL.');
  const db = createDb(url);
  try {
    const existing = await db.selectFrom('tenants').select('id').where('cnpj', '=', '11222333000181').executeTakeFirst();
    if (existing) {
      console.log('Dados de demonstração já existem.');
      return;
    }
    const tenant = await db.insertInto('tenants')
      .values({ legal_name: 'Metalúrgica Exemplo Ltda (fictícia)', trade_name: 'Metalúrgica Exemplo', cnpj: '11222333000181' })
      .returning('id').executeTakeFirstOrThrow();
    const [admin, sst, sup, exec, plat] = await db.insertInto('users').values([
      { email: 'admin@sitedopai.local', display_name: 'Ana Administradora (fictícia)' },
      { email: 'sst@sitedopai.local', display_name: 'Sérgio SST (fictício)' },
      { email: 'supervisor@sitedopai.local', display_name: 'Sueli Supervisora (fictícia)' },
      { email: 'executante@sitedopai.local', display_name: 'Edson Executante (fictício)' },
      { email: 'plataforma@sitedopai.local', display_name: 'Paula Plataforma (fictícia)' },
    ]).returning('id').execute();
    await db.insertInto('platform_admins').values({ user_id: plat!.id }).execute();

    await withContext(db, { tenantId: tenant.id }, async (tx) => {
      const [u1, u2] = await tx.insertInto('units').values([
        { tenant_id: tenant.id, name: 'Planta Hortolândia', code: 'HTL', city: 'Hortolândia', state: 'SP' },
        { tenant_id: tenant.id, name: 'Planta Campinas', code: 'CPS', city: 'Campinas', state: 'SP' },
      ]).returning('id').execute();
      await tx.insertInto('sectors').values([
        { tenant_id: tenant.id, unit_id: u1!.id, name: 'Manutenção elétrica' },
        { tenant_id: tenant.id, unit_id: u1!.id, name: 'Caldeiraria' },
        { tenant_id: tenant.id, unit_id: u2!.id, name: 'Utilidades' },
      ]).execute();
      const grants: [string, 'COMPANY_ADMIN' | 'SST' | 'SUPERVISOR' | 'EXECUTOR', string | null][] = [
        [admin!.id, 'COMPANY_ADMIN', null], [sst!.id, 'SST', null], [sup!.id, 'SUPERVISOR', u1!.id], [exec!.id, 'EXECUTOR', u1!.id],
      ];
      for (const [userId, role, unitId] of grants) {
        const m = await tx.insertInto('memberships').values({ tenant_id: tenant.id, user_id: userId, status: 'INVITED' }).returning('id').executeTakeFirstOrThrow();
        await tx.insertInto('role_assignments').values({ tenant_id: tenant.id, membership_id: m.id, role, scope_type: unitId ? 'UNIT' : 'TENANT', unit_id: unitId }).execute();
      }
    });
    console.log(`Empresa de demonstração criada: ${tenant.id}`);
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
