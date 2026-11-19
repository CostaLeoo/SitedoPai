/**
 * Permissão de Trabalho no celular: preparação, análise, medições, liberação
 * assinada (com novo login quando o login está antigo), ciência de cada um,
 * entradas, suspensão automática por gás, saída sempre permitida, retomada,
 * suspensão pelo vigia e encerramento assinado.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, Page, test } from '@playwright/test';
import { join } from 'node:path';
import { loginAs, TMP } from './env';

test.describe.configure({ mode: 'serial' });
let ptUrl: string;

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click();
const shot = (page: Page, name: string) => page.screenshot({ path: join(TMP, 'telas', `${name}.png`) });
const open = async (page: Page, who: 'exec' | 'sup' | 'sst' | 'sst2', t?: string, opts?: { authAgeSeconds?: number }) => {
  await loginAs(page, who, opts);
  await page.goto(ptUrl);
  await expect(page.getByRole('heading', { name: /PT-2026-/ })).toBeVisible();
  if (t) await tab(page, t);
};
async function measure(page: Page, o2: string, lie = '0') {
  await tab(page, 'Medições');
  await page.getByLabel(/Instrumento/).fill('Detector 4 gases SN 0001 (teste)');
  await page.getByLabel(/Oxigênio/).fill(o2);
  await page.getByLabel(/Inflamáveis/).fill(lie);
  await page.getByRole('button', { name: 'Registrar medições' }).click();
}
async function acknowledgeAll(page: Page) {
  for (const who of ['exec', 'sup', 'sst2'] as const) {
    await open(page, who, 'Liberação');
    await page.getByRole('button', { name: 'Assinar ciência' }).click();
    await expect(page.getByText('Sua ciência está registrada.')).toBeVisible();
  }
}

test('executante cria a PT a partir de uma APR aprovada', async ({ page }) => {
  await loginAs(page, 'exec');
  await page.goto('/pts');
  await expect(page.getByText('Nenhuma PT ainda.')).toBeVisible();
  await page.getByRole('link', { name: 'Nova PT' }).click();
  await page.getByLabel('APR aprovada').selectOption({ label: 'APR-2026-000500 — Limpeza interna do tanque T-01' });
  await expect(page.getByText(/Validade máxima deste tipo: 8 h/)).toBeVisible();
  await page.getByLabel(/^Local/).fill('Tanque T-01, boca de visita norte');
  await page.getByLabel(/Descrição da atividade/).fill('Limpeza interna e inspeção visual');
  await page.getByRole('button', { name: 'Criar PT' }).click();
  await expect(page.getByRole('heading', { name: 'PT-2026-000001' })).toBeVisible();
  await expect(page.getByText('NÃO VALE COMO AUTORIZAÇÃO', { exact: true })).toBeVisible();
  ptUrl = page.url();
});

test('monta a equipe, responde o checklist e envia para análise', async ({ page }) => {
  await open(page, 'exec', 'Dados');
  for (const [person, fn] of [['Edson Executante', 'Executante'], ['Sueli Supervisora', 'Supervisor de entrada'], ['Silvia Vigia', 'Vigia']]) {
    await page.getByLabel('Pessoa').selectOption({ label: person! });
    await page.getByLabel('Função').selectOption({ label: fn! });
    await page.getByRole('button', { name: 'Incluir na equipe' }).click();
  }
  await page.getByRole('button', { name: 'Salvar equipe' }).click();
  await tab(page, 'Checklist');
  for (const n of [1, 2]) {
    const q = page.locator(`article[data-question="${n}"]`);
    await q.getByLabel('Sim', { exact: true }).check();
    await expect(q.getByText('Salvo', { exact: true })).toBeVisible();
  }
  await tab(page, 'Liberação');
  await page.getByRole('button', { name: 'Enviar para análise' }).click();
  await expect(page.getByText('Em análise')).toBeVisible();
});

test('SST analisa; executante mede os gases', async ({ page }) => {
  await open(page, 'sst', 'Liberação');
  await page.getByRole('button', { name: 'Enviar para aprovação' }).click();
  await expect(page.getByText('Aguardando aprovação')).toBeVisible();
  await open(page, 'exec');
  await measure(page, '20,9');
  await expect(page.getByText('Medições registradas dentro dos limites.')).toBeVisible();
});

test('liberação com login antigo pede para entrar de novo; com login recente, libera', async ({ page }) => {
  await open(page, 'sup', 'Liberação', { authAgeSeconds: 3600 });
  await page.getByRole('button', { name: 'Assinar liberação' }).click();
  await expect(page.getByText('Confirme sua identidade', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar de novo para assinar' })).toBeVisible();
  await open(page, 'sup', 'Liberação');
  await page.getByRole('button', { name: 'Assinar liberação' }).click();
  await expect(page.getByText('PT VÁLIDA', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspender PT' })).toBeVisible();
  await shot(page, '6-pt-valida');
});

test('cada integrante assina a ciência; supervisor inicia e controla entradas', async ({ page }) => {
  await acknowledgeAll(page);
  await open(page, 'sup', 'Liberação');
  await page.getByRole('button', { name: 'Iniciar execução' }).click();
  await expect(page.getByText(/Em execução · vale até/)).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: 'Edson Executante' }).getByRole('button', { name: 'Registrar entrada' }).click();
  await expect(page.getByText('1 pessoa(s) dentro')).toBeVisible();
});

test('gás fora do limite suspende na hora; a saída continua possível', async ({ page }) => {
  await open(page, 'exec');
  await measure(page, '18,2');
  await expect(page.getByText(/fora do limite\. A PT foi suspensa\./)).toBeVisible();
  await expect(page.getByText('NÃO VALE COMO AUTORIZAÇÃO', { exact: true })).toBeVisible();
  await expect(page.getByText(/Oxigênio fora dos limites \(18,2 %\)/)).toBeVisible();
  await tab(page, 'Liberação');
  await shot(page, '7-pt-suspensa');
  await page.getByRole('listitem').filter({ hasText: 'Edson Executante' }).getByRole('button', { name: 'Registrar saída' }).click();
  await expect(page.getByText('0 pessoa(s) dentro')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrar entrada' })).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('retomada assinada exige nova medição; depois, o vigia suspende pelo botão', async ({ page }) => {
  await open(page, 'sup', 'Liberação');
  await page.getByRole('button', { name: 'Assinar retomada' }).click();
  await expect(page.getByText(/Meça Oxigênio de novo/).first()).toBeVisible();
  await measure(page, '20,8');
  await tab(page, 'Liberação');
  await page.getByRole('button', { name: 'Assinar retomada' }).click();
  await expect(page.getByText('PT VÁLIDA', { exact: true })).toBeVisible();
  await acknowledgeAll(page);
  await open(page, 'sup', 'Liberação');
  await page.getByRole('button', { name: 'Iniciar execução' }).click();
  await expect(page.getByText(/Em execução · vale até/)).toBeVisible();

  await open(page, 'sst2');
  await page.getByRole('button', { name: 'Suspender PT' }).click();
  await page.getByLabel(/Por que suspender/).fill('Odor estranho perto da boca de visita');
  await page.getByRole('button', { name: 'Confirmar suspensão' }).click();
  await expect(page.getByText('Motivo: Odor estranho perto da boca de visita')).toBeVisible();
});

test('supervisor encerra; assinaturas conferem', async ({ page }) => {
  await open(page, 'sup', 'Liberação');
  const sign = page.getByRole('button', { name: 'Assinar encerramento' });
  await expect(sign).toBeDisabled();
  await page.getByLabel('Área inspecionada e liberada').check();
  await page.getByLabel('Toda a equipe saiu do local').check();
  await sign.click();
  await expect(page.getByText(/Encerrada/).first()).toBeVisible();
  await tab(page, 'Assinaturas');
  await expect(page.getByText('O conteúdo da PT é o mesmo que foi assinado na última liberação.')).toBeVisible();
  await expect(page.getByText('Encerramento ·')).toBeVisible();
  await expect(page.getByText('FALHA DE INTEGRIDADE')).toHaveCount(0);
  await shot(page, '8-pt-assinaturas');
});
