/**
 * Comercial: plano, assinatura, atraso, modo somente consulta e exportação.
 * Roda por último (z-) porque deixa a empresa em atraso durante o teste.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs } from './env';

test.describe.configure({ mode: 'serial' });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const company = (page: import('@playwright/test').Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Metalúrgica E2E', exact: true }) });

test('plataforma cria plano e contrata para a empresa, sem ver conteúdo', async ({ page }) => {
  await loginAs(page, 'plat');
  await page.goto('/plataforma');
  await expect(page.getByRole('heading', { name: 'Empresas e assinaturas' })).toBeVisible();
  await page.getByLabel('Código (ex.: basico)').fill('basico-e2e');
  await page.getByLabel('Nome do plano').fill('Básico E2E');
  await page.getByLabel('Mensalidade (R$)').fill('199,90');
  await page.getByLabel('Máximo de unidades (vazio = sem limite)').fill('5');
  await page.getByRole('button', { name: 'Criar plano' }).click();
  await expect(page.getByText('Básico E2E · R$ 199,90/mês')).toBeVisible();

  await company(page).getByRole('button', { name: 'Gerenciar' }).click();
  await company(page).getByLabel('Dias de tolerância após o vencimento').fill('3');
  await company(page).getByRole('button', { name: 'Contratar' }).click();
  await expect(page.getByText('Plano contratado.')).toBeVisible();
  await expect(company(page)).toContainText('Básico E2E · R$ 199,90 · Em dia · tolerância 3 dia(s)');
  // Contagens sim; conteúdo não.
  await expect(company(page)).toContainText('APRs');
  expect(await page.locator('main').innerText()).not.toContain('Tanque T-01');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);

  // Cobrança vencida há 10 dias (tolerância 3): conta vai para somente consulta.
  await company(page).getByLabel('Vencimento').fill(daysAgo(10));
  await company(page).getByRole('button', { name: 'Gerar cobrança simulada' }).click();
  await expect(company(page).getByText('Somente consulta', { exact: true }).first()).toBeVisible();
});

test('empresa em somente consulta: aviso claro, cobranças visíveis e exportação funciona', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/assinatura');
  await expect(page.getByText('Conta em modo somente consulta', { exact: true })).toBeVisible();
  await expect(page.getByText('suspender, registrar entrada e saída, medir gases e encerrar')).toBeVisible();
  await expect(page.getByText('R$ 199,90 · vence')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar dados (ZIP)' }).click();
  const file = await (await download).path();
  expect(readFileSync(file!).subarray(0, 2).toString()).toBe('PK');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
});

test('pagamento devolve a conta para ativa', async ({ page }) => {
  await loginAs(page, 'plat');
  await page.goto('/plataforma');
  await company(page).getByRole('button', { name: 'Gerenciar' }).click();
  await company(page).getByRole('button', { name: 'Simular pagamento' }).click();
  await expect(company(page).getByText('Ativa', { exact: true }).first()).toBeVisible();
  await loginAs(page, 'exec');
  await page.goto('/aprs');
  await expect(page.getByRole('heading', { name: 'APRs' })).toBeVisible();
  await expect(page.getByText('somente consulta')).toHaveCount(0);
});
