/**
 * Travas da Fase 2a no próprio banco: valem mesmo se a API tiver um defeito.
 */
import { createDb, Db, sql, Tx, withContext } from '../src';
import { APP_URL, Fixture, OWNER_URL, resetDatabase, seedFixture } from './helpers';

let owner: Db;
let app: Db;
let f: Fixture;
let ids: Record<string, string>;
const ctx = () => ({ tenantId: f.tenantA, userId: f.userA });
const levels = JSON.stringify([1, 2, 3].map((v) => ({ value: v, label: String(v) })));

beforeAll(async () => {
  await resetDatabase();
  owner = createDb(OWNER_URL);
  app = createDb(APP_URL);
  f = await seedFixture(owner);
  ids = await withContext(app, ctx(), async (tx) => {
    const m = await tx.insertInto('risk_matrices').values({
      tenant_id: f.tenantA, name: 'M', created_by: f.userA, probability_levels: levels, severity_levels: levels,
      classes: JSON.stringify([{ min: 1, max: 4, label: 'ok', acceptable: true }, { min: 5, max: 9, label: 'não', acceptable: false }]),
    }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('risk_matrices').set({ status: 'PUBLISHED' }).where('id', '=', m.id).execute();
    const t = await tx.insertInto('apr_templates').values({ tenant_id: f.tenantA, name: 'T', service_type: 'x', created_by: f.userA }).returning('id').executeTakeFirstOrThrow();
    const v = await tx.insertInto('apr_template_versions').values({ tenant_id: f.tenantA, template_id: t.id, version: 1, author_id: f.userA }).returning('id').executeTakeFirstOrThrow();
    const q = await tx.insertInto('apr_template_questions').values({ tenant_id: f.tenantA, template_version_id: v.id, position: 1, text: 'Q', expected_answer: 'YES', photos_max: 1 })
      .returning('id').executeTakeFirstOrThrow();
    return { matrix: m.id, template: t.id, version: v.id, question: q.id };
  });
});
afterAll(async () => {
  await owner.destroy();
  await app.destroy();
});

const run = <T>(fn: (tx: Tx) => Promise<T>) => withContext(app, ctx(), fn);

describe('modelos e matriz', () => {
  it('não publica sem revisor diferente do autor e sem validação profissional', async () => {
    await expect(run((tx) => tx.updateTable('apr_template_versions').set({ status: 'PUBLISHED', reviewed_by: f.userA }).where('id', '=', ids.version!).execute()))
      .rejects.toThrow(/check constraint/);
  });

  it('não cria APR a partir de versão não publicada', async () => {
    await expect(run((tx) => tx.insertInto('aprs').values({
      tenant_id: f.tenantA, number: 'X', template_version_id: ids.version!, risk_matrix_id: ids.matrix!, unit_id: f.unitA,
      activity_date: '2026-11-09', created_by: f.userA, team: '[]', equipment: '[]',
    }).execute())).rejects.toThrow(/publicado/);
  });

  it('versão publicada e suas perguntas ficam imutáveis', async () => {
    await run((tx) => tx.updateTable('apr_template_versions').set({
      status: 'PUBLISHED', reviewed_by: f.userB, professional_validation: JSON.stringify({ name: 'x', registry: 'y', date: '2026-11-09' }),
    }).where('id', '=', ids.version!).execute());
    await expect(run((tx) => tx.updateTable('apr_template_questions').set({ text: 'alterada' }).where('id', '=', ids.question!).execute())).rejects.toThrow(/rascunho/);
    await expect(run((tx) => tx.deleteFrom('apr_template_questions').where('id', '=', ids.question!).execute())).rejects.toThrow(/rascunho/);
    await expect(run((tx) => tx.updateTable('apr_template_versions').set({ review_note: 'x' }).where('id', '=', ids.version!).execute())).rejects.toThrow(/publicado/);
    await expect(run((tx) => tx.updateTable('risk_matrices').set({ classes: '[]' }).where('id', '=', ids.matrix!).execute())).rejects.toThrow(/publicado/);
  });
});

describe('APR', () => {
  let apr: string;

  beforeAll(async () => {
    apr = await run(async (tx) => {
      const num = await sql<{ n: string }>`SELECT next_apr_number(2026) AS n`.execute(tx);
      return (await tx.insertInto('aprs').values({
        tenant_id: f.tenantA, number: num.rows[0]!.n, template_version_id: ids.version!, risk_matrix_id: ids.matrix!, unit_id: f.unitA,
        activity_date: '2026-11-09', created_by: f.userA, team: '[]', equipment: '[]',
      }).returning('id').executeTakeFirstOrThrow()).id;
    });
  });

  const photo = (tx: Tx) => tx.insertInto('apr_photos').values({
    tenant_id: f.tenantA, apr_id: apr, question_id: ids.question!, apr_revision: 0, original_key: 'k', display_key: 'k2',
    mime_type: 'image/jpeg', size_bytes: 1, sha256: 'a'.repeat(64), uploaded_by: f.userA,
  }).returning('id').executeTakeFirstOrThrow();

  it('limita fotos por pergunta e nunca apaga foto', async () => {
    const p = await run(photo);
    await expect(run(photo)).rejects.toThrow(/limite de fotos/);
    // Duas camadas: a aplicação nem tem permissão de DELETE; o dono do schema esbarra no gatilho.
    await expect(run((tx) => tx.deleteFrom('apr_photos').where('id', '=', p.id).execute())).rejects.toThrow(/permission denied/);
    await expect(withContext(owner, ctx(), (tx) => tx.deleteFrom('apr_photos').where('id', '=', p.id).execute())).rejects.toThrow(/remoção lógica/);
    await expect(run((tx) => tx.updateTable('apr_photos').set({ sha256: 'b'.repeat(64) }).where('id', '=', p.id).execute())).rejects.toThrow(/não podem ser alterados/);
    await run((tx) => tx.updateTable('apr_photos').set({ removed_at: new Date(), removed_by: f.userA }).where('id', '=', p.id).execute());
    await expect(run((tx) => tx.updateTable('apr_photos').set({ removed_at: null }).where('id', '=', p.id).execute())).rejects.toThrow(/restaurada/);
  });

  it('não aprova com quem criou', async () => {
    await expect(run((tx) => tx.updateTable('aprs').set({ status: 'APPROVED', decided_by: f.userA }).where('id', '=', apr).execute())).rejects.toThrow(/check constraint/);
  });

  it('APR aprovada não muda, nem respostas, nem fotos; e nunca é apagada', async () => {
    await run((tx) => tx.insertInto('apr_answers').values({ tenant_id: f.tenantA, apr_id: apr, question_id: ids.question!, answer: 'YES', answered_by: f.userA }).execute());
    await run((tx) => tx.updateTable('aprs').set({ status: 'APPROVED', decided_by: f.userB }).where('id', '=', apr).execute());
    await expect(run((tx) => tx.updateTable('aprs').set({ location: 'x' }).where('id', '=', apr).execute())).rejects.toThrow(/finalizada/);
    await expect(run((tx) => tx.updateTable('apr_answers').set({ answer: 'NO' }).where('apr_id', '=', apr).execute())).rejects.toThrow(/edição/);
    await expect(run(photo)).rejects.toThrow(/edição/);
    await expect(run((tx) => tx.deleteFrom('aprs').where('id', '=', apr).execute())).rejects.toThrow(/permission denied/);
    await expect(withContext(owner, ctx(), (tx) => tx.deleteFrom('aprs').where('id', '=', apr).execute())).rejects.toThrow(/apagada/);
  });

  it('numeração é sequencial por empresa e ano', async () => {
    const n = await run(async (tx) => (await sql<{ n: string }>`SELECT next_apr_number(2026) AS n`.execute(tx)).rows[0]!.n);
    expect(n).toBe('APR-2026-000002');
    const other = await withContext(app, { tenantId: f.tenantB }, async (tx) => (await sql<{ n: string }>`SELECT next_apr_number(2026) AS n`.execute(tx)).rows[0]!.n);
    expect(other).toBe('APR-2026-000001');
  });
});
