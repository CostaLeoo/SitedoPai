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
    await tx.insertInto('risk_matrices').values({
      tenant_id: tenant.id, name: 'Matriz 5×5', created_by: ids.sst!, status: 'PUBLISHED',
      probability_levels: levels(['Rara', 'Improvável', 'Possível', 'Provável', 'Quase certa']),
      severity_levels: levels(['Leve', 'Moderada', 'Séria', 'Grave', 'Catastrófica']),
      classes: JSON.stringify([
        { min: 1, max: 4, label: 'Baixo', acceptable: true }, { min: 5, max: 9, label: 'Médio', acceptable: true },
        { min: 10, max: 14, label: 'Alto', acceptable: false }, { min: 15, max: 25, label: 'Crítico', acceptable: false },
      ]),
    }).execute();
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
