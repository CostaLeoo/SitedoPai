/**
 * Visão geral (painel) e navegação pelo menu lateral no celular.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loginAs } from './env';

test('painel mostra contagens reais e o menu leva às telas', async ({ page }) => {
  await loginAs(page, 'sup');
  await page.goto('/');
  await expect(page).toHaveURL(/\/painel$/);
  await expect(page.getByRole('heading', { name: /Olá, Sueli/ })).toBeVisible();
  const aprovadas = page.locator('section[aria-label="Indicadores"] > div').filter({ hasText: 'APRs aprovadas' });
  await expect(aprovadas.locator('strong')).not.toHaveText('0');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);

  await page.getByRole('button', { name: 'Abrir menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('link', { name: 'Visão geral' })).toHaveAttribute('aria-current', 'page');
  await menu.getByRole('link', { name: 'APRs' }).click();
  await expect(page).toHaveURL(/\/aprs$/);
  await expect(page.getByRole('heading', { name: 'APRs' })).toBeVisible();
});
