/** Travas da PT no próprio banco: máquina de estados, imutabilidade e entradas. */
import { createDb, Db, Tx, withContext } from '../src';
import { APP_URL, Fixture, OWNER_URL, resetDatabase, seedFixture } from './helpers';

let owner: Db;
let app: Db;
let f: Fixture;
const ids: Record<string, string> = {};
const run = <T>(fn: (tx: Tx) => Promise<T>) => withContext(app, { tenantId: f.tenantA, userId: f.userA }, fn);
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withContext(owner, { tenantId: f.tenantA }, fn);
const setStatus = (status: string, extra: Record<string, unknown> = {}) =>
  run((tx) => tx.updateTable('work_permits').set({ status: status as never, ...extra }).where('id', '=', ids.pt!).execute());

beforeAll(async () => {
  await resetDatabase();
  owner = createDb(OWNER_URL);
  app = createDb(APP_URL);
  f = await seedFixture(owner);
  await asOwner(async (tx) => {
    const lv = JSON.stringify([{ value: 1, label: '1' }]);
    const m = await tx.insertInto('risk_matrices').values({ tenant_id: f.tenantA, name: 'M', created_by: f.userA, status: 'PUBLISHED', probability_levels: lv, severity_levels: lv,
      classes: JSON.stringify([{ min: 1, max: 1, label: 'ok', acceptable: true }]) }).returning('id').executeTakeFirstOrThrow();
    const t = await tx.insertInto('apr_templates').values({ tenant_id: f.tenantA, name: 'T', service_type: 'x', created_by: f.userA }).returning('id').executeTakeFirstOrThrow();
    const v = await tx.insertInto('apr_template_versions').values({ tenant_id: f.tenantA, template_id: t.id, version: 1, author_id: f.userA }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('apr_template_versions').set({ status: 'PUBLISHED', reviewed_by: f.userB, professional_validation: '{"name":"x","registry":"y","date":"2026-11-01"}' }).where('id', '=', v.id).execute();
    const apr = await tx.insertInto('aprs').values({ tenant_id: f.tenantA, number: 'A', template_version_id: v.id, risk_matrix_id: m.id, unit_id: f.unitA, activity_date: '2026-11-09',
      created_by: f.userA, team: '[]', equipment: '[]' }).returning('id').executeTakeFirstOrThrow();
    const pt = await tx.insertInto('pt_types').values({ tenant_id: f.tenantA, name: 'P', checklist_template_version_id: v.id, max_validity_minutes: 60, author_id: f.userA, gas_parameters: '[]' })
      .returning('id').executeTakeFirstOrThrow();
    const wk = await tx.insertInto('workers').values({ tenant_id: f.tenantA, full_name: 'W', user_id: f.userA }).returning('id').executeTakeFirstOrThrow();
    const qt = await tx.insertInto('qualification_types').values({ tenant_id: f.tenantA, name: 'Q', kind: 'TRAINING' }).returning('id').executeTakeFirstOrThrow();
    const wq = await tx.insertInto('worker_qualifications').values({ tenant_id: f.tenantA, worker_id: wk.id, type_id: qt.id, valid_from: '2026-01-01', valid_until: '2027-01-01', recorded_by: f.userA })
      .returning('id').executeTakeFirstOrThrow();
    const wp = await tx.insertInto('work_permits').values({ tenant_id: f.tenantA, number: 'PT-1', pt_type_id: pt.id, apr_id: apr.id, unit_id: f.unitA, location: 'x', description: 'x',
      starts_at: new Date(Date.now() - 60000), ends_at: new Date(Date.now() + 3600_000), created_by: f.userA }).returning('id').executeTakeFirstOrThrow();
    const snap = await tx.insertInto('document_snapshots').values({ tenant_id: f.tenantA, document_type: 'work_permit', document_id: wp.id, content: '{}',
      hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' }).returning('id').executeTakeFirstOrThrow();
    const sig = await tx.insertInto('signatures').values({ tenant_id: f.tenantA, document_type: 'work_permit', document_id: wp.id, snapshot_id: snap.id,
      document_hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', meaning: 'ACKNOWLEDGE', signer_user_id: f.userA, signer_name: 'W',
      signer_context: '{}', evidence: '{}' }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('pt_team').values({ tenant_id: f.tenantA, pt_id: wp.id, worker_id: wk.id, function: 'EXECUTOR', acknowledged_signature_id: sig.id }).execute();
    Object.assign(ids, { pt: wp.id, worker: wk.id, wq: wq.id, sig: sig.id });
  });
});
afterAll(async () => {
  await owner.destroy();
  await app.destroy();
});

it('não pula etapas da máquina de estados', async () => {
  await expect(setStatus('RELEASED', { released_by: f.userB })).rejects.toThrow(/transição de DRAFT para RELEASED/);
  await expect(setStatus('IN_EXECUTION')).rejects.toThrow(/transição/);
});

it('dados da PT não mudam depois do envio', async () => {
  await setStatus('IN_ANALYSIS');
  await expect(run((tx) => tx.updateTable('work_permits').set({ ends_at: new Date(Date.now() + 7200_000) }).where('id', '=', ids.pt!).execute())).rejects.toThrow(/não podem ser alterados/);
  await expect(run((tx) => tx.insertInto('pt_team').values({ tenant_id: f.tenantA, pt_id: ids.pt!, worker_id: ids.worker!, function: 'EXECUTOR' }).execute())).rejects.toThrow(/equipe/);
});

it('entrada só em execução; saída em qualquer situação, uma vez', async () => {
  const enter = () => run((tx) => tx.insertInto('pt_entries').values({ tenant_id: f.tenantA, pt_id: ids.pt!, worker_id: ids.worker!, entered_by: f.userA }).returning('id').executeTakeFirstOrThrow());
  await setStatus('AWAITING_APPROVAL');
  await expect(enter()).rejects.toThrow(/não autorizada/);
  await setStatus('RELEASED', { released_by: f.userB });
  await expect(enter()).rejects.toThrow(/não autorizada/);
  await setStatus('IN_EXECUTION');
  const e = await enter();
  await setStatus('SUSPENDED');
  await run((tx) => tx.updateTable('pt_entries').set({ exited_at: new Date(), exited_by: f.userA }).where('id', '=', e.id).execute());
  await expect(run((tx) => tx.updateTable('pt_entries').set({ exited_at: new Date(), exited_by: f.userA }).where('id', '=', e.id).execute())).rejects.toThrow(/uma vez/);
});

it('snapshot com hash que não confere é recusado', async () => {
  await expect(run((tx) => tx.insertInto('document_snapshots').values({ tenant_id: f.tenantA, document_type: 'x', document_id: ids.pt!, content: '{"a":1}', hash: 'f'.repeat(64) }).execute()))
    .rejects.toThrow(/check constraint/);
});

it('medições, assinaturas e qualificações não são alteradas nem apagadas', async () => {
  await expect(run((tx) => tx.updateTable('pt_measurements').set({ instrument: 'x' }).execute())).rejects.toThrow(/permission denied/);
  await expect(run((tx) => tx.deleteFrom('signatures').execute())).rejects.toThrow(/permission denied/);
  await expect(asOwner((tx) => tx.updateTable('signatures').set({ meaning: 'RELEASE' }).where('id', '=', ids.sig!).execute())).rejects.toThrow(/somente inserção/);
  await expect(run((tx) => tx.deleteFrom('worker_qualifications').where('id', '=', ids.wq!).execute())).rejects.toThrow(/permission denied/);
  await expect(run((tx) => tx.updateTable('worker_qualifications').set({ valid_until: '2030-01-01' }).where('id', '=', ids.wq!).execute())).rejects.toThrow(/não pode ser alterada/);
  await expect(asOwner((tx) => tx.deleteFrom('worker_qualifications').where('id', '=', ids.wq!).execute())).rejects.toThrow(/revogue/);
});

it('PT nunca é apagada', async () => {
  await expect(run((tx) => tx.deleteFrom('work_permits').where('id', '=', ids.pt!).execute())).rejects.toThrow(/permission denied/);
  await expect(asOwner((tx) => tx.deleteFrom('work_permits').where('id', '=', ids.pt!).execute())).rejects.toThrow(/cancele/);
});
