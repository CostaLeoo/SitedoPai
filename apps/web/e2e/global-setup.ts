/**
 * Sobe o ambiente de ponta a ponta: banco limpo com dados fictícios, um
 * servidor de chaves (JWKS) no lugar do Keycloak, a API e o site.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { createDb, withContext } from '../../../packages/db/src';
import { APP_URL, OWNER_URL, resetDatabase } from '../../../packages/db/test/helpers';
import { ISSUER, TMP } from './env';

const ROOT = resolve(__dirname, '../../..');

async function waitFor(url: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Tempo esgotado esperando ${url}`);
}

async function seed() {
  await resetDatabase();
  const owner = createDb(OWNER_URL);
  const ids: Record<string, string> = {};
  const tenant = await owner.insertInto('tenants').values({ legal_name: 'Metalúrgica E2E Ltda (fictícia)', trade_name: 'Metalúrgica E2E', cnpj: '11222333000181' })
    .returning('id').executeTakeFirstOrThrow();
  ids.tenant = tenant.id;
  const people = [['exec', 'Edson Executante'], ['sup', 'Sueli Supervisora'], ['sst', 'Sérgio SST'], ['sst2', 'Silvia SST']];
  for (const [key, name] of people) {
    const u = await owner.insertInto('users').values({ email: `${key}@e2e.test`, display_name: `${name} (fictício)`, oidc_subject: `sub-${key}` })
      .returning('id').executeTakeFirstOrThrow();
    ids[key!] = u.id;
  }
  await withContext(owner, { tenantId: tenant.id }, async (tx) => {
    const unit = await tx.insertInto('units').values({ tenant_id: tenant.id, name: 'Planta Hortolândia', code: 'HTL' }).returning('id').executeTakeFirstOrThrow();
    for (const [key, role] of [['exec', 'EXECUTOR'], ['sup', 'SUPERVISOR'], ['sst', 'SST'], ['sst2', 'SST']] as const) {
      const m = await tx.insertInto('memberships').values({ tenant_id: tenant.id, user_id: ids[key]!, status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('role_assignments').values({ tenant_id: tenant.id, membership_id: m.id, role, scope_type: 'TENANT' }).execute();
    }
    const levels = (names: string[]) => JSON.stringify(names.map((label, i) => ({ value: i + 1, label })));
    const matrix = await tx.insertInto('risk_matrices').values({
      tenant_id: tenant.id, name: 'Matriz 5×5', created_by: ids.sst!, status: 'PUBLISHED',
      probability_levels: levels(['Rara', 'Improvável', 'Possível', 'Provável', 'Quase certa']),
      severity_levels: levels(['Leve', 'Moderada', 'Séria', 'Grave', 'Catastrófica']),
      classes: JSON.stringify([
        { min: 1, max: 4, label: 'Baixo', acceptable: true }, { min: 5, max: 9, label: 'Médio', acceptable: true },
        { min: 10, max: 14, label: 'Alto', acceptable: false }, { min: 15, max: 25, label: 'Crítico', acceptable: false },
      ]),
    }).returning('id').executeTakeFirstOrThrow();
    const tpl = await tx.insertInto('apr_templates').values({ tenant_id: tenant.id, name: 'Trabalho em altura', service_type: 'altura', created_by: ids.sst! })
      .returning('id').executeTakeFirstOrThrow();
    const v = await tx.insertInto('apr_template_versions').values({ tenant_id: tenant.id, template_id: tpl.id, version: 1, author_id: ids.sst! })
      .returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('apr_template_questions').values([
      { tenant_id: tenant.id, template_version_id: v.id, position: 1, text: 'Os equipamentos de proteção individual exigidos foram verificados?',
        expected_answer: 'YES', criticality: 'HIGH', photos_required: 1, photos_max: 3, mismatch_effect: 'PENDING', normative_ref: 'NR-06' },
      { tenant_id: tenant.id, template_version_id: v.id, position: 2, text: 'A área de trabalho está devidamente sinalizada e isolada?',
        expected_answer: 'YES', criticality: 'CRITICAL', photos_max: 5, mismatch_effect: 'BLOCK' },
      { tenant_id: tenant.id, template_version_id: v.id, position: 3, text: 'Há linhas elétricas energizadas próximas ao local?',
        expected_answer: 'NO', criticality: 'HIGH', allow_na: true, justification_on: ['YES'], mismatch_effect: 'PENDING' },
    ]).execute();
    await tx.updateTable('apr_template_versions').set({
      status: 'PUBLISHED', reviewed_by: ids.sst2!, reviewed_at: new Date(), published_at: new Date(),
      professional_validation: JSON.stringify({ name: 'Eng. Fictício', registry: 'CREA-SP 0000000', date: '2026-11-09' }),
    }).where('id', '=', v.id).execute();

    // ---- Permissão de Trabalho: cadastros prontos (valores de TESTE, não normativos) ----
    const pv = JSON.stringify({ name: 'Eng. Fictício', registry: 'CREA-SP 0000000', date: '2026-11-09' });
    const ck = await tx.insertInto('apr_templates').values({ tenant_id: tenant.id, name: 'Checklist PT espaço confinado', service_type: 'pt', created_by: ids.sst! }).returning('id').executeTakeFirstOrThrow();
    const ckv = await tx.insertInto('apr_template_versions').values({ tenant_id: tenant.id, template_id: ck.id, version: 1, author_id: ids.sst! }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('apr_template_questions').values([
      { tenant_id: tenant.id, template_version_id: ckv.id, position: 1, text: 'Ventilação instalada e funcionando?', expected_answer: 'YES', criticality: 'CRITICAL', mismatch_effect: 'BLOCK' },
      { tenant_id: tenant.id, template_version_id: ckv.id, position: 2, text: 'Energias perigosas bloqueadas e etiquetadas?', expected_answer: 'YES', criticality: 'HIGH', mismatch_effect: 'PENDING' },
    ]).execute();
    await tx.updateTable('apr_template_versions').set({ status: 'PUBLISHED', reviewed_by: ids.sst2!, published_at: new Date(), professional_validation: pv }).where('id', '=', ckv.id).execute();
    const qt: Record<string, string> = {};
    for (const [k, name, kind] of [['aut', 'Trabalhador autorizado (teste)', 'TRAINING'], ['sup', 'Supervisor de entrada (teste)', 'TRAINING'],
      ['vig', 'Vigia (teste)', 'TRAINING'], ['lib', 'Designação: liberação de PT', 'DESIGNATION']] as const) {
      qt[k] = (await tx.insertInto('qualification_types').values({ tenant_id: tenant.id, name, kind }).returning('id').executeTakeFirstOrThrow()).id;
    }
    for (const [user, name, quals] of [['exec', 'Edson Executante', ['aut']], ['sup', 'Sueli Supervisora', ['sup', 'lib']], ['sst2', 'Silvia Vigia', ['vig']]] as const) {
      const wk = await tx.insertInto('workers').values({ tenant_id: tenant.id, full_name: name, user_id: ids[user]! }).returning('id').executeTakeFirstOrThrow();
      for (const q of quals) {
        await tx.insertInto('worker_qualifications').values({ tenant_id: tenant.id, worker_id: wk.id, type_id: qt[q]!, valid_from: '2026-01-01', valid_until: '2027-12-31', recorded_by: ids.sst! }).execute();
      }
    }
    const ptt = await tx.insertInto('pt_types').values({
      tenant_id: tenant.id, name: 'Espaço confinado', checklist_template_version_id: ckv.id, max_validity_minutes: 480, author_id: ids.sst!,
      requires_gas_monitoring: true, gas_max_age_minutes: 30, requires_entry_log: true, releaser_qualification_type_id: qt.lib!,
      gas_parameters: JSON.stringify([{ key: 'o2', label: 'Oxigênio', unit: '%', min: 19.5, max: 23 }, { key: 'lie', label: 'Inflamáveis', unit: '%LIE', max: 10 }]),
    }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('pt_type_requirements').values([
      { tenant_id: tenant.id, pt_type_id: ptt.id, function: 'EXECUTOR', min_count: 1, qualification_type_ids: [qt.aut!] },
      { tenant_id: tenant.id, pt_type_id: ptt.id, function: 'ENTRY_SUPERVISOR', min_count: 1, qualification_type_ids: [qt.sup!] },
      { tenant_id: tenant.id, pt_type_id: ptt.id, function: 'ATTENDANT', min_count: 1, qualification_type_ids: [qt.vig!] },
    ]).execute();
    await tx.updateTable('pt_types').set({ status: 'PUBLISHED', reviewed_by: ids.sst2!, published_at: new Date(), professional_validation: pv }).where('id', '=', ptt.id).execute();
    const apr = await tx.insertInto('aprs').values({ tenant_id: tenant.id, number: 'APR-2026-000500', template_version_id: v.id, risk_matrix_id: matrix.id, unit_id: unit.id,
      activity_date: '2026-11-09', location: 'Tanque T-01', service_description: 'Limpeza interna do tanque T-01', created_by: ids.exec!, team: '[]', equipment: '[]' })
      .returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('aprs').set({ status: 'IN_REVIEW' }).where('id', '=', apr.id).execute();
    await tx.updateTable('aprs').set({ status: 'APPROVED', decided_by: ids.sup! }).where('id', '=', apr.id).execute();
    ids.approvedApr = apr.id;
  });
  await owner.destroy();
  return ids;
}

export default async function globalSetup() {
  mkdirSync(TMP, { recursive: true });
  const ids = await seed();
  writeFileSync(join(TMP, 'ids.json'), JSON.stringify(ids));

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' };
  writeFileSync(join(TMP, 'private.json'), JSON.stringify(await exportJWK(privateKey)));
  const jwks = createServer((_, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwks.listen(3999, r));

  const procs: ChildProcess[] = [];
  const start = (cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
    procs.push(p);
  };
  start('node', ['dist/main.js'], join(ROOT, 'apps/api'), {
    DATABASE_URL: APP_URL,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: 'sitedopai-api',
    OIDC_JWKS_URL: 'http://localhost:3999/jwks',
    CORS_ORIGINS: 'http://localhost:3000',
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'sitedopai-e2e-')),
    PORT: '3001',
  });
  start('npx', ['next', 'start', '-p', '3000'], join(ROOT, 'apps/web'), {});
  await waitFor('http://localhost:3001/health');
  await waitFor('http://localhost:3000/entrar');

  return async () => {
    // Derruba o grupo inteiro (npx → next-server), não só o processo pai.
    for (const p of procs) {
      try {
        process.kill(-p.pid!, 'SIGTERM');
      } catch {
        /* já encerrado */
      }
    }
    jwks.close();
  };
}
