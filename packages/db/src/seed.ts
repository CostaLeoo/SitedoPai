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
      // Matriz e modelo de EXEMPLO em rascunho: só viram uso operacional depois
      // que o SST da empresa revisar e publicar, identificando o profissional.
      await tx.insertInto('risk_matrices').values({
        tenant_id: tenant.id, name: 'Matriz 5×5 (exemplo — revisar)', created_by: sst!.id,
        probability_levels: JSON.stringify(['Rara', 'Improvável', 'Possível', 'Provável', 'Quase certa'].map((label, i) => ({ value: i + 1, label }))),
        severity_levels: JSON.stringify(['Leve', 'Moderada', 'Séria', 'Grave', 'Catastrófica'].map((label, i) => ({ value: i + 1, label }))),
        classes: JSON.stringify([
          { min: 1, max: 4, label: 'Baixo', acceptable: true }, { min: 5, max: 9, label: 'Médio', acceptable: true },
          { min: 10, max: 14, label: 'Alto', acceptable: false }, { min: 15, max: 25, label: 'Crítico', acceptable: false },
        ]),
      }).execute();
      const tpl = await tx.insertInto('apr_templates').values({ tenant_id: tenant.id, name: 'Exemplo — trabalho em altura (não validado)', service_type: 'altura', created_by: sst!.id })
        .returning('id').executeTakeFirstOrThrow();
      const ver = await tx.insertInto('apr_template_versions').values({ tenant_id: tenant.id, template_id: tpl.id, version: 1, author_id: sst!.id })
        .returning('id').executeTakeFirstOrThrow();
      const qs: [string, 'YES' | 'NO', 'MEDIUM' | 'HIGH' | 'CRITICAL', 'ALERT' | 'PENDING' | 'BLOCK', number, number, boolean][] = [
        ['Os equipamentos de proteção individual exigidos foram verificados?', 'YES', 'HIGH', 'PENDING', 1, 3, false],
        ['A área de trabalho está devidamente sinalizada e isolada?', 'YES', 'CRITICAL', 'BLOCK', 1, 5, false],
        ['Os trabalhadores possuem as autorizações necessárias?', 'YES', 'CRITICAL', 'BLOCK', 0, 0, false],
        ['Há linhas elétricas energizadas próximas ao local?', 'NO', 'HIGH', 'PENDING', 0, 2, true],
      ];
      await tx.insertInto('apr_template_questions').values(qs.map(([text, expected, crit, effect, req, max, na], i) => ({
        tenant_id: tenant.id, template_version_id: ver.id, position: i + 1, text, expected_answer: expected, criticality: crit,
        mismatch_effect: effect, photos_required: req, photos_max: max, allow_na: na,
      }))).execute();
      await tx.insertInto('hazard_library').values([
        { tenant_id: tenant.id, hazard: 'Queda de altura', consequence: 'Lesões graves ou morte', tags: ['altura'],
          suggested_controls: JSON.stringify([{ description: 'Proteção coletiva (guarda-corpo, linha de vida)', type: 'ENGINEERING' }, { description: 'Cinto tipo paraquedista com talabarte duplo', type: 'PPE' }]) },
        { tenant_id: tenant.id, hazard: 'Choque elétrico', consequence: 'Queimaduras, parada cardiorrespiratória', tags: ['elétrico'],
          suggested_controls: JSON.stringify([{ description: 'Desenergização com bloqueio e etiquetagem', type: 'ELIMINATION' }]) },
      ]).execute();
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
