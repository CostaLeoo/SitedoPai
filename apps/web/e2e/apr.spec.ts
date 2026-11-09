/**
 * Fluxo completo no celular (Pixel 7, Chrome): executante preenche a APR,
 * supervisor faz a nova avaliação da pergunta crítica, executante envia e
 * supervisor aprova. Verifica também as regras visuais do formulário e a
 * acessibilidade (WCAG 2.2 AA) com o axe.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, Page, test } from '@playwright/test';
import sharp from 'sharp';
import { join } from 'node:path';
import { loginAs, TMP } from './env';

const shot = (page: Page, name: string) => page.screenshot({ path: join(TMP, 'telas', `${name}.png`), fullPage: false });

test.describe.configure({ mode: 'serial' });

let aprUrl: string;
let photo: Buffer;

test.beforeAll(async () => {
  photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#2a7' } }).jpeg().toBuffer();
});

const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(name) }).click();
const question = (page: Page, n: number) => page.locator(`article[data-question="${n}"]`);

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('sem login, vai para a tela de entrada', async ({ page }) => {
  await page.goto('/aprs');
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(page.getByRole('button', { name: 'Entrar com sua conta' })).toBeVisible();
});

test('executante cria a APR e preenche os dados', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto('/aprs');
  await expect(page.getByText('Nenhuma APR ainda.')).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('link', { name: 'Nova APR' }).click();

  // Com um único modelo, matriz e unidade, o formulário já vem preenchido.
  await expect(page.getByLabel('Tipo de serviço (modelo)')).toHaveValue(/.+/);
  await page.getByLabel('Data da atividade').fill('2026-11-10');
  await page.getByRole('button', { name: 'Criar APR' }).click();
  await expect(page.getByRole('heading', { name: /APR-2026-000001/ })).toBeVisible();
  aprUrl = page.url();

  await page.getByLabel(/Local da atividade/).fill('Galpão 3, cobertura');
  await page.getByLabel(/Descrição do serviço/).fill('Troca de telhas danificadas');
  await page.getByLabel(/Responsável/).fill('Edson (fictício)');
  await page.getByLabel(/Equipe executante/).fill('Edson (fictício)\nCaio (fictício)');
  await page.getByLabel(/Equipamentos utilizados/).fill('Andaime tubular');
  await page.getByLabel(/Equipamentos utilizados/).blur();
  await expect(page.getByText('Salvo', { exact: true })).toBeVisible();
});

test('checklist: perguntas uma abaixo da outra, botões grandes e regras de N/A', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto(aprUrl);
  await tab(page, 'Checklist');
  const boxes = await Promise.all([1, 2, 3].map(async (n) => (await question(page, n).boundingBox())!));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height);
    expect(Math.abs(boxes[i]!.x - boxes[0]!.x)).toBeLessThan(1);
  }
  const options = question(page, 1).locator('label:has(input[type=radio])');
  await expect(options).toHaveCount(3);
  for (const o of await options.all()) expect((await o.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await expect(question(page, 1).getByLabel(/N\/A/)).toBeDisabled();
  await expect(question(page, 3).getByLabel(/N\/A/)).toBeEnabled();
  await noHorizontalScroll(page);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('executante responde, anexa e remove fotos, e trata a pergunta crítica', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto(aprUrl);
  await tab(page, 'Checklist');

  const q1 = question(page, 1);
  await q1.getByLabel('Sim', { exact: true }).check();
  await expect(q1.getByText('Salvo', { exact: true })).toBeVisible();
  await expect(q1.getByText('mínimo 1')).toBeVisible();
  await q1.getByTestId('gallery-1').setInputFiles([
    { name: 'epi-1.jpg', mimeType: 'image/jpeg', buffer: photo },
    { name: 'epi-2.jpg', mimeType: 'image/jpeg', buffer: photo },
  ]);
  await expect(q1.getByAltText('Foto 2 da pergunta 1')).toBeVisible();
  await expect(q1.getByText('Fotos: 2 de 3')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await q1.getByRole('button', { name: 'Remover foto 2' }).click();
  await expect(q1.getByText('Fotos: 1 de 3')).toBeVisible();

  const bad = await q1.getByTestId('gallery-1').setInputFiles({ name: 'virus.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('MZ não sou foto') });
  void bad;
  await expect(q1.getByText('Envie uma foto em JPEG, PNG ou WebP.')).toBeVisible();

  const q2 = question(page, 2);
  await q2.getByLabel('Não', { exact: true }).check();
  await expect(q2.getByText('Atividade bloqueada')).toBeVisible();
  await q2.getByLabel(/Justificativa/).fill('Fita zebrada rompida pelo vento');
  await q2.getByLabel(/Ação corretiva/).fill('Isolamento refeito com grade metálica');
  await q2.getByLabel(/Ação corretiva/).blur();
  await expect(q2.getByText('Aguardando outra pessoa avaliar de novo.')).toBeVisible();
  await expect(q2.getByText('Quem respondeu não pode fazer a nova avaliação.')).toBeVisible();

  // Aqui "Sim" é a resposta insegura: o sistema pede justificativa e ação.
  const q3 = question(page, 3);
  await q3.getByLabel('Sim', { exact: true }).check();
  await expect(q3.getByText('Ação corretiva necessária')).toBeVisible();
  await q3.getByLabel('N/A (Não se aplica)').check();
  await expect(q3.getByText('Salvo', { exact: true })).toBeVisible();
  await expect(q3.getByText('Ação corretiva necessária')).toHaveCount(0);
  await q1.scrollIntoViewIfNeeded();
  await shot(page, '1-checklist');
  await q2.scrollIntoViewIfNeeded();
  await shot(page, '2-pergunta-critica');
});

test('executante faz a análise de riscos com classificação na tela', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto(aprUrl);
  await tab(page, 'Riscos');
  await page.getByRole('button', { name: 'Adicionar etapa' }).click();
  const step = page.getByRole('region', { name: 'Etapa 1' });
  await step.getByLabel(/O que é feito nesta etapa/).fill('Montagem do andaime');
  await step.getByLabel(/^Perigo/).fill('Queda de altura');
  await step.getByLabel(/Possíveis consequências/).fill('Fraturas ou morte');
  await step.getByLabel('Probabilidade', { exact: true }).selectOption('4');
  await step.getByLabel('Severidade', { exact: true }).selectOption('5');
  await expect(step.getByText(/Risco inicial: Crítico \(pontuação 20\) — não aceitável/)).toBeVisible();
  await step.getByLabel('Medida 1').fill('Andaime com guarda-corpo e rodapé');
  await step.getByLabel('Probabilidade residual').selectOption('3');
  await step.getByLabel('Severidade residual').selectOption('4');
  await expect(step.getByText(/Risco residual: Alto \(pontuação 12\) — não aceitável/)).toBeVisible();
  await step.getByLabel('Probabilidade residual').selectOption('1');
  await expect(step.getByText(/Risco residual: Baixo \(pontuação 4\) — aceitável/)).toBeVisible();
  await expect(page.getByText('Análise salva')).toBeVisible();
  await step.getByText(/Risco residual: Baixo/).scrollIntoViewIfNeeded();
  await shot(page, '3-riscos');
});

test('envio fica bloqueado até a nova avaliação por outra pessoa', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto(aprUrl);
  await tab(page, 'Enviar');
  await expect(page.getByText(/outra pessoa precisa avaliar de novo/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar para revisão' })).toBeDisabled();
  await shot(page, '4-pendencias');
});

test('supervisor faz a nova avaliação da pergunta crítica', async ({ page }) => {
  await loginAs(page, 'sup');
  await page.goto(aprUrl);
  await tab(page, 'Checklist');
  const q2 = question(page, 2);
  await q2.getByRole('button', { name: 'Sim, avaliei e está segura' }).click();
  await expect(q2.getByText('Condição confirmada como segura.')).toBeVisible();
});

test('executante envia e não consegue aprovar a própria APR', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto(aprUrl);
  await tab(page, 'Enviar');
  await expect(page.getByText('Sem pendências')).toBeVisible();
  await page.getByRole('button', { name: 'Enviar para revisão' }).click();
  await expect(page.getByText('Em revisão')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprovar APR' })).toHaveCount(0);
  await tab(page, 'Checklist');
  await expect(question(page, 1).getByLabel('Sim', { exact: true })).toBeDisabled();
});

test('supervisor aprova; a APR fica travada', async ({ page }) => {
  await loginAs(page, 'sup');
  await page.goto(aprUrl);
  await tab(page, 'Enviar');
  await page.getByLabel(/Observação/).fill('Condições conferidas no local');
  await page.getByRole('button', { name: 'Aprovar APR' }).click();
  await expect(page.getByText('APR aprovada')).toBeVisible();
  await tab(page, 'Dados');
  await expect(page.getByLabel(/Local da atividade/)).toBeDisabled();
  await page.goto('/aprs');
  await expect(page.getByRole('link', { name: /APR-2026-000001/ })).toContainText('Aprovada');
  await shot(page, '5-lista');
});
