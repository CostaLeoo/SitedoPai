/**
 * PDF com QR Code e verificação pública.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ids, loginAs } from './env';

let code = '';

test.describe.configure({ mode: 'serial' });

test('emite e baixa o PDF da APR; a emissão fica listada', async ({ page }) => {
  await loginAs(page, 'sup');
  await page.goto(`/aprs/${ids().approvedApr}`);
  await expect(page.getByRole('heading', { name: 'PDF e verificação' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Emitir PDF' }).click();
  const file = await (await download).path();
  expect(readFileSync(file!).subarray(0, 5).toString()).toBe('%PDF-');
  const item = page.getByRole('list', { name: 'Emissões anteriores' }).getByRole('listitem').first();
  await expect(item).toContainText('Emissão 1 · Aprovada');
  code = (await item.locator('a.font-mono').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-7]{24}$/);
});

test('verificação pública sem login mostra a situação e nenhum dado pessoal', async ({ page }) => {
  await page.goto(`/v/${code}`);
  await expect(page.getByText('APR aprovada')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'APR APR-2026-000500' })).toBeVisible();
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('Tanque T-01');
  expect(body).not.toContain('Limpeza interna');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
});

test('código desconhecido avisa que o papel não é autêntico', async ({ page }) => {
  await page.goto('/v/AAAAAAAAAAAAAAAAAAAAAAAA');
  await expect(page.getByText('Documento não encontrado')).toBeVisible();
});
