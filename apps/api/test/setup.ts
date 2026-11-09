import { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';
import { createDb, Db, withContext } from '@sitedopai/db';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
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
}

export async function token(o: TokenOptions): Promise<string> {
  const jwt = new SignJWT({
    email: o.email,
    email_verified: o.emailVerified ?? true,
    amr: o.mfa === false ? ['pwd'] : ['pwd', 'otp'],
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
  const app = await createApp(config, createLocalJWKSet({ keys: [jwk] }), false);
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

  const people = ['adminA', 'supA1', 'execA', 'auditA', 'adminB', 'adminC', 'platform'];
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
    const grant = async (user: string, role: 'COMPANY_ADMIN' | 'SUPERVISOR' | 'EXECUTOR' | 'AUDITOR', unitId?: string) => {
      const m = await tx.insertInto('memberships').values({ tenant_id: ids.alfa!, user_id: ids[user]!, status: 'ACTIVE' }).returning('id').executeTakeFirstOrThrow();
      ids[`m_${user}`] = m.id;
      await tx.insertInto('role_assignments').values({ tenant_id: ids.alfa!, membership_id: m.id, role, scope_type: unitId ? 'UNIT' : 'TENANT', unit_id: unitId ?? null }).execute();
    };
    await grant('adminA', 'COMPANY_ADMIN');
    await grant('supA1', 'SUPERVISOR', ids.unitA1);
    await grant('execA', 'EXECUTOR');
    await grant('auditA', 'AUDITOR');
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
  return { app, owner, ids };
}

export async function destroyWorld(w: World): Promise<void> {
  await w.app.close();
  await w.owner.destroy();
}
