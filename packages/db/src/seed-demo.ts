/**
 * Modo DEMONSTRAÇÃO, só para testar o fluxo completo no computador local.
 *
 * Publica a matriz e o modelo de exemplo e cria um tipo de PT, trabalhadores e
 * qualificações FICTÍCIOS, todos identificados como "DEMONSTRAÇÃO — sem
 * validação profissional". Nada disso é conteúdo normativo nem pode ser usado
 * em atividade real. Recusa rodar com NODE_ENV=production.
 *
 *   pnpm db:seed && pnpm db:seed:demo
 */
import { createDb, withContext } from './index';

const DEMO_VALIDATION = JSON.stringify({ name: 'DEMONSTRAÇÃO — sem validação profissional', registry: '—', date: new Date().toISOString().slice(0, 10) });

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Modo demonstração não pode rodar em produção.');
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('Defina DATABASE_OWNER_URL (veja .env.example).');
  const db = createDb(url);
  try {
    const tenant = await db.selectFrom('tenants').select('id').where('cnpj', '=', '11222333000181').executeTakeFirst();
    if (!tenant) throw new Error('Rode antes: pnpm db:seed');
    const t = tenant.id;
    const user = async (email: string) => (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
    const [sst, sup, exec] = [await user('sst@sitedopai.local'), await user('supervisor@sitedopai.local'), await user('executante@sitedopai.local')];

    await withContext(db, { tenantId: t }, async (tx) => {
      if (await tx.selectFrom('pt_types').select('id').where('name', 'like', 'DEMONSTRAÇÃO%').executeTakeFirst()) {
        console.log('Modo demonstração já aplicado.');
        return;
      }
      // Segundo SST: publicar exige revisão por outra pessoa.
      const sst2 = (await tx.insertInto('users').values({ email: 'sst2@sitedopai.local', display_name: 'Silvia SST (fictícia)' })
        .onConflict((oc) => oc.column('email').doUpdateSet({ display_name: 'Silvia SST (fictícia)' })).returning('id').executeTakeFirstOrThrow()).id;
      const m = await tx.insertInto('memberships').values({ tenant_id: t, user_id: sst2, status: 'INVITED' }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('role_assignments').values({ tenant_id: t, membership_id: m.id, role: 'SST', scope_type: 'TENANT' }).execute();

      await tx.updateTable('risk_matrices').set({ status: 'PUBLISHED', name: 'DEMONSTRAÇÃO — Matriz 5×5 (sem validação)' }).where('status', '=', 'DRAFT').execute();
      await tx.updateTable('apr_templates').set({ name: 'DEMONSTRAÇÃO — Trabalho em altura (sem validação)' }).where('service_type', '=', 'altura').execute();
      await tx.updateTable('apr_template_versions').set({
        status: 'PUBLISHED', reviewed_by: sst2, reviewed_at: new Date(), published_at: new Date(), professional_validation: DEMO_VALIDATION,
      }).where('status', '=', 'DRAFT').execute();

      // Checklist e tipo de PT. Limites de gases FICTÍCIOS, só para ver o fluxo.
      const ck = await tx.insertInto('apr_templates').values({ tenant_id: t, name: 'DEMONSTRAÇÃO — Checklist PT espaço confinado', service_type: 'pt', created_by: sst })
        .returning('id').executeTakeFirstOrThrow();
      const ckv = await tx.insertInto('apr_template_versions').values({ tenant_id: t, template_id: ck.id, version: 1, author_id: sst }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('apr_template_questions').values([
        { tenant_id: t, template_version_id: ckv.id, position: 1, text: 'Ventilação instalada e funcionando?', expected_answer: 'YES', criticality: 'CRITICAL', mismatch_effect: 'BLOCK' },
        { tenant_id: t, template_version_id: ckv.id, position: 2, text: 'Energias perigosas bloqueadas e etiquetadas?', expected_answer: 'YES', criticality: 'HIGH', mismatch_effect: 'PENDING' },
      ]).execute();
      await tx.updateTable('apr_template_versions').set({ status: 'PUBLISHED', reviewed_by: sst2, reviewed_at: new Date(), published_at: new Date(), professional_validation: DEMO_VALIDATION })
        .where('id', '=', ckv.id).execute();

      const qt: Record<string, string> = {};
      for (const [k, name, kind] of [['aut', 'DEMONSTRAÇÃO — Trabalhador autorizado', 'TRAINING'], ['sup', 'DEMONSTRAÇÃO — Supervisor de entrada', 'TRAINING'],
        ['vig', 'DEMONSTRAÇÃO — Vigia', 'TRAINING'], ['lib', 'DEMONSTRAÇÃO — Designação para liberar PT', 'DESIGNATION']] as const) {
        qt[k] = (await tx.insertInto('qualification_types').values({ tenant_id: t, name, kind }).returning('id').executeTakeFirstOrThrow()).id;
      }
      const year = new Date().getFullYear();
      for (const [uid, name, quals] of [[exec, 'Edson Executante (fictício)', ['aut']], [sup, 'Sueli Supervisora (fictícia)', ['sup', 'lib']], [sst2, 'Silvia Vigia (fictícia)', ['vig']]] as const) {
        const wk = await tx.insertInto('workers').values({ tenant_id: t, full_name: name, user_id: uid }).returning('id').executeTakeFirstOrThrow();
        for (const q of quals) {
          await tx.insertInto('worker_qualifications').values({ tenant_id: t, worker_id: wk.id, type_id: qt[q]!, valid_from: `${year}-01-01`, valid_until: `${year + 1}-12-31`, recorded_by: sst }).execute();
        }
      }
      const ptt = await tx.insertInto('pt_types').values({
        tenant_id: t, name: 'DEMONSTRAÇÃO — Espaço confinado (valores fictícios)', checklist_template_version_id: ckv.id, max_validity_minutes: 480, author_id: sst,
        requires_gas_monitoring: true, gas_max_age_minutes: 30, requires_entry_log: true, releaser_qualification_type_id: qt.lib!,
        gas_parameters: JSON.stringify([{ key: 'o2', label: 'Oxigênio (fictício)', unit: '%', min: 19.5, max: 23 }, { key: 'lie', label: 'Inflamáveis (fictício)', unit: '%LIE', max: 10 }]),
      }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('pt_type_requirements').values([
        { tenant_id: t, pt_type_id: ptt.id, function: 'EXECUTOR', min_count: 1, qualification_type_ids: [qt.aut!] },
        { tenant_id: t, pt_type_id: ptt.id, function: 'ENTRY_SUPERVISOR', min_count: 1, qualification_type_ids: [qt.sup!] },
        { tenant_id: t, pt_type_id: ptt.id, function: 'ATTENDANT', min_count: 1, qualification_type_ids: [qt.vig!] },
      ]).execute();
      await tx.updateTable('pt_types').set({ status: 'PUBLISHED', reviewed_by: sst2, published_at: new Date(), professional_validation: DEMO_VALIDATION }).where('id', '=', ptt.id).execute();
      console.log('Modo demonstração aplicado: matriz, modelo de APR e tipo de PT publicados (sem validação profissional).');
    });
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
