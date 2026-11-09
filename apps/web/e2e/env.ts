import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { importJWK, SignJWT } from 'jose';

export const TMP = join(__dirname, '.tmp');
export const ISSUER = 'https://idp.e2e.test/realms/sitedopai';
// Valores padrão embutidos no build do site (lib/config.ts).
const AUTHORITY = 'http://localhost:8080/realms/sitedopai';
const CLIENT_ID = 'sitedopai-web';

export const ids = (): Record<string, string> => JSON.parse(readFileSync(join(TMP, 'ids.json'), 'utf8'));

/**
 * Simula o login: coloca no sessionStorage o usuário OIDC que o oidc-client-ts
 * guardaria após o retorno do Keycloak, com um token assinado pela chave de teste.
 */
export async function loginAs(page: Page, who: 'exec' | 'sup' | 'sst' | 'sst2', opts: { authAgeSeconds?: number } = {}) {
  const key = await importJWK(JSON.parse(readFileSync(join(TMP, 'private.json'), 'utf8')), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: `${who}@e2e.test`, email_verified: true, amr: ['pwd', 'otp'], auth_time: now - (opts.authAgeSeconds ?? 0), sid: `e2e-${who}` })
    .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
    .setSubject(`sub-${who}`).setIssuer(ISSUER).setAudience('sitedopai-api')
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const user = { access_token: token, token_type: 'Bearer', scope: 'openid profile email', profile: { sub: `sub-${who}`, iss: AUTHORITY, aud: CLIENT_ID, exp: now + 3600, iat: now }, expires_at: now + 3600 };
  await page.addInitScript(([k, v]) => {
    window.sessionStorage.setItem(k!, v!);
  }, [`oidc.user:${AUTHORITY}:${CLIENT_ID}`, JSON.stringify(user)]);
}
