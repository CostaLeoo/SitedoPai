/**
 * Cabeçalhos de segurança do site e CSP com nonce (sem scripts inline livres).
 */
import { expect, test } from '@playwright/test';
import { ids, loginAs } from './env';

test('CSP com nonce: nenhum script bloqueado e nenhum script inline sem nonce', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|CSP/i.test(m.text())) violations.push(m.text()); });
  const res = await page.goto('/entrar');
  const h = res!.headers();
  const csp = h['content-security-policy']!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp.split(';').find((d) => d.trim().startsWith('script-src'))).not.toContain('unsafe-inline');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-powered-by']).toBeUndefined();
  // Nonce muda a cada requisição.
  const again = (await page.request.get('/entrar')).headers()['content-security-policy'];
  expect(again).not.toBe(csp);
  // A página hidrata (React rodando) e um fluxo autenticado funciona sob a CSP.
  await loginAs(page, 'sup');
  await page.goto(`/aprs/${ids().approvedApr}`);
  await expect(page.getByRole('heading', { name: 'PDF e verificação' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('API: cabeçalhos de segurança e nada de detalhes internos em erro', async ({ request }) => {
  const r = await request.get('http://localhost:3001/aprs/00000000-0000-0000-0000-000000000000');
  expect(r.status()).toBe(401);
  const h = r.headers();
  expect(h['x-powered-by']).toBeUndefined();
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['strict-transport-security']).toBeDefined();
  const body = await r.text();
  expect(body).not.toMatch(/stack|at .*\.ts|node_modules|SELECT|postgres/i);
});
