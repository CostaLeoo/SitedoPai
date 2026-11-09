import sharp from 'sharp';
import { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';
import { createDb, Db, withContext } from '@sitedopai/db';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage } from '../src/storage/storage';
import { APP_URL, OWNER_URL, resetDatabase } from '../../../packages/db/test/helpers';

export const ISSUER = 'https://idp.test/realms/sitedopai';
export const AUDIENCE = 'sitedopai-api';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let signingKey: Key;
let otherKey: Key;

export interface TokenOptions {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  mfa?: boolean;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  key?: 'valid' | 'other';
  /** Há quantos segundos a pessoa fez login (claim auth_time). Padrão: agora. */
  authAgeSeconds?: number;
}

export async function token(o: TokenOptions): Promise<string> {
  const jwt = new SignJWT({
    email: o.email,
    email_verified: o.emailVerified ?? true,
    amr: o.mfa === false ? ['pwd'] : ['pwd', 'otp'],
    auth_time: Math.floor(Date.now() / 1000) - (o.authAgeSeconds ?? 0),
    sid: 'sessao-teste',
  })
    .setProtectedHeader({ alg: 'RS256', kid: o.key === 'other' ? 'other' : 'k1' })
    .setSubject(o.sub)
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '5m');
  return jwt.sign(o.key === 'other' ? otherKey : signingKey);
}

export interface World {
  app: INestApplication;
  owner: Db;
  ids: Record<string, string>;
  storageDir: string;
}

export const MATRIX = {
  probabilityLevels: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: `P${v}` })),
  severityLevels: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: `S${v}` })),
  classes: [
    { min: 1, max: 4, label: 'Baixo', acceptable: true },
    { min: 5, max: 9, label: 'Médio', acceptable: true },
    { min: 10, max: 14, label: 'Alto', acceptable: false },
    { min: 15, max: 25, label: 'Crítico', acceptable: false },
  ],
};

/** APR completa na empresa Beta, alvo das tentativas de acesso cruzado. */
async function seedBetaApr(owner: Db, ids: Record<string, string>) {
  await withContext(owner, { tenantId: ids.beta }, async (tx) => {
    const m = await tx.insertInto('risk_matrices').values({
      tenant_id: ids.beta!, name: 'Matriz Beta', created_by: ids.adminB!, status: 'PUBLISHED',
      probability_levels: JSON.stringify(MATRIX.probabilityLevels), severity_levels: JSON.stringify(MATRIX.severityLevels),
      classes: JSON.stringify(MATRIX.classes),
    }).returning('id').executeTakeFirstOrThrow();
    const tp = await tx.insertInto('apr_templates').values({ tenant_id: ids.beta!, name: 'Altura Beta', service_type: 'altura', created_by: ids.adminB! })
      .returning('id').executeTakeFirstOrThrow();
    const v = await tx.insertInto('apr_template_versions').values({ tenant_id: ids.beta!, template_id: tp.id, version: 1, author_id: ids.adminB! })
      .returning('id').executeTakeFirstOrThrow();
    const q = await tx.insertInto('apr_template_questions').values({
      tenant_id: ids.beta!, template_version_id: v.id, position: 1, text: 'Cinto inspecionado?', expected_answer: 'YES', photos_max: 2,
    }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('apr_template_versions').set({
      status: 'PUBLISHED', reviewed_by: ids.adminC!, reviewed_at: new Date(), published_at: new Date(),
      professional_validation: JSON.stringify({ name: 'Eng. Fictício', registry: 'CREA 000', date: '2026-11-01' }),
    }).where('id', '=', v.id).execute();
    const apr = await tx.insertInto('aprs').values({
      tenant_id: ids.beta!, number: 'APR-2026-000001', template_version_id: v.id, risk_matrix_id: m.id, unit_id: ids.unitB1!,
      activity_date: '2026-11-09', location: 'Telhado Beta', service_description: 'Segredo da Beta', created_by: ids.adminB!,
      team: '[]', equipment: '[]',
    }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('apr_answers').values({ tenant_id: ids.beta!, apr_id: apr.id, question_id: q.id, answer: 'YES', answered_by: ids.adminB! }).execute();
    const photo = await tx.insertInto('apr_photos').values({
      tenant_id: ids.beta!, apr_id: apr.id, question_id: q.id, apr_revision: 0, original_key: 'x/original', display_key: 'x/display.jpg',
      mime_type: 'image/jpeg', size_bytes: 10, sha256: 'b'.repeat(64), uploaded_by: ids.adminB!,
    }).returning('id').executeTakeFirstOrThrow();
    Object.assign(ids, { matrixB: m.id, templateB: tp.id, versionB: v.id, questionB: q.id, aprB: apr.id, photoB: photo.id });

    // PT da Beta (alvo da varredura entre empresas).
    const qt = await tx.insertInto('qualification_types').values({ tenant_id: ids.beta!, name: 'Treinamento Beta', kind: 'TRAINING' }).returning('id').executeTakeFirstOrThrow();
    const wk = await tx.insertInto('workers').values({ tenant_id: ids.beta!, full_name: 'Trabalhador Beta', user_id: ids.adminB! }).returning('id').executeTakeFirstOrThrow();
    const wq = await tx.insertInto('worker_qualifications').values({ tenant_id: ids.beta!, worker_id: wk.id, type_id: qt.id, valid_from: '2026-01-01', valid_until: '2027-12-31', recorded_by: ids.adminB! })
      .returning('id').executeTakeFirstOrThrow();
    const ptt = await tx.insertInto('pt_types').values({
      tenant_id: ids.beta!, name: 'PT Beta', checklist_template_version_id: v.id, max_validity_minutes: 480, author_id: ids.adminB!,
      gas_parameters: '[]', status: 'PUBLISHED', reviewed_by: ids.adminC!, professional_validation: JSON.stringify({ name: 'x', registry: 'y', date: '2026-11-01' }),
    }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('aprs').set({ status: 'IN_REVIEW' }).where('id', '=', apr.id).execute();
    await tx.updateTable('aprs').set({ status: 'APPROVED', decided_by: ids.adminC! }).where('id', '=', apr.id).execute();
    const pt = await tx.insertInto('work_permits').values({
      tenant_id: ids.beta!, number: 'PT-2026-000001', pt_type_id: ptt.id, apr_id: apr.id, unit_id: ids.unitB1!, location: 'Tanque Beta',
      description: 'Segredo da Beta', starts_at: new Date(), ends_at: new Date(Date.now() + 3600_000), created_by: ids.adminB!,
    }).returning('id').executeTakeFirstOrThrow();
    Object.assign(ids, { qualTypeB: qt.id, workerB: wk.id, workerQualB: wq.id, ptTypeB: ptt.id, ptB: pt.id });
  });
}

/**
 * Sobe a API contra um banco limpo, com chaves locais no lugar do Keycloak,
 * e cria dados fictícios:
 *  - Alfa: unidades A1 e A2; admin, supervisor só da A1, executante, auditor.
 *  - Beta: unidade B1; admin.
 *  - Gama: empresa em modo somente leitura; admin.
 *  - Um administrador da plataforma.
 */
export async function createWorld(): Promise<World> {
  await resetDatabase();
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  const config = loadConfig({
    DATABASE_URL: APP_URL,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    RATE_LIMIT_PER_MINUTE: '100000',
  } as NodeJS.ProcessEnv);
  const storageDir = mkdtempSync(join(tmpdir(), 'sitedopai-test-'));
  const app = await createApp(config, createLocalJWKSet({ keys: [jwk] }), false, new LocalStorage(storageDir));
  await app.init();

  const owner = createDb(OWNER_URL);
  const ids: Record<string, string> = {};

  const tenants = await owner.insertInto('tenants').values([
    { legal_name: 'Alfa Indústria Ltda (fictícia)', trade_name: 'Alfa', cnpj: '11111111000191' },
    { legal_name: 'Beta Construções Ltda (fictícia)', trade_name: 'Beta', cnpj: '22222222000182' },
    { legal_name: 'Gama Serviços Ltda (fictícia)', trade_name: 'Gama', cnpj: '33333333000173', status: 'READ_ONLY' },
  ]).returning('id').execute();
  ids.alfa = tenants[0]!.id;
  ids.beta = tenants[1]!.id;
  ids.gama = tenants[2]!.id;

  const people = ['adminA', 'supA1', 'execA', 'auditA', 'sstA', 'sst2A', 'adminB', 'adminC', 'platform'];
  const users = await owner.insertInto('users').values(
    people.map((p) => ({ email: `${p.toLowerCase()}@exemplo.test`, display_name: `${p} (fictício)`, oidc_subject: `sub-${p}` })),
  ).returning(['id', 'email']).execute();
  people.forEach((p, i) => (ids[p] = users[i]!.id));
  await owner.insertInto('platform_admins').values({ user_id: ids.platform! }).execute();

  await withContext(owner, { tenantId: ids.alfa }, async (tx) => {
    const units = await tx.insertInto('units').values([
      { tenant_id: ids.alfa!, name: 'Planta Campinas', code: 'A1' },
      { tenant_id: ids.alfa!, name: 'Planta Sumaré', code: 'A2' },
    ]).returning('id').execute();
    ids.unitA1 = units[0]!.id;
    ids.unitA2 = units[1]!.id;
    const grant = async (user: string, role: 'COMPANY_ADMIN' | 'SST' | 'SUPERVISOR' | 'EXECUTOR' | 'AUDITOR', unitId?: string) => {
      const m = await tx.insertInto('memberships').values({ tenant_id: ids.alfa!, user_id: ids[user]!, status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
      ids[`m_${user}`] = m.id;
      await tx.insertInto('role_assignments').values({ tenant_id: ids.alfa!, membership_id: m.id, role, scope_type: unitId ? 'UNIT' : 'TENANT', unit_id: unitId ?? null }).execute();
    };
    await grant('adminA', 'COMPANY_ADMIN');
    await grant('supA1', 'SUPERVISOR', ids.unitA1);
    await grant('execA', 'EXECUTOR');
    await grant('auditA', 'AUDITOR');
    await grant('sstA', 'SST');
    await grant('sst2A', 'SST');
  });

  for (const [tenant, user, code] of [['beta', 'adminB', 'B1'], ['gama', 'adminC', 'C1']] as const) {
    await withContext(owner, { tenantId: ids[tenant] }, async (tx) => {
      const u = await tx.insertInto('units').values({ tenant_id: ids[tenant]!, name: `Unidade ${code}`, code }).returning('id').executeTakeFirstOrThrow();
      ids[`unit${code}`] = u.id;
      const m = await tx.insertInto('memberships').values({ tenant_id: ids[tenant]!, user_id: ids[user]!, status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
      ids[`m_${user}`] = m.id;
      await tx.insertInto('role_assignments').values({ tenant_id: ids[tenant]!, membership_id: m.id, role: 'COMPANY_ADMIN', scope_type: 'TENANT' }).execute();
      const s = await tx.insertInto('sectors').values({ tenant_id: ids[tenant]!, unit_id: u.id, name: 'Manutenção' }).returning('id').executeTakeFirstOrThrow();
      ids[`sector${code}`] = s.id;
    });
  }
  await seedBetaApr(owner, ids);
  // Cópia de exibição da foto da Beta (usada no PDF).
  const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4a7' } }).jpeg().toBuffer();
  mkdirSync(join(storageDir, 'x'), { recursive: true });
  writeFileSync(join(storageDir, 'x', 'display.jpg'), photo);
  return { app, owner, ids, storageDir };
}

export async function destroyWorld(w: World): Promise<void> {
  await w.app.close();
  await w.owner.destroy();
}
