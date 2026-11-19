import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { sql, withContext } from '@sitedopai/db';
import { createWorld, destroyWorld, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;
let authB: string;
const asB = (r: request.Test) => r.set('Authorization', authB).set('X-Tenant-Id', w.ids.beta!);
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const toFile = (buf: Buffer) => {
  const f = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'd.pdf');
  writeFileSync(f, buf);
  return f;
};
const pdfText = (buf: Buffer) => execFileSync('pdftotext', ['-layout', toFile(buf), '-'], { encoding: 'utf8' });

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  authB = `Bearer ${await token({ sub: 'sub-adminB' })}`;
});
afterAll(async () => destroyWorld(w));

describe('emissão de PDF', () => {
  let aprDoc: { id: string; verificationCode: string; sha256: string; sequence: number };

  it('emite o PDF da APR aprovada com QR, número, código e situação', async () => {
    aprDoc = (await asB(http.post(`/aprs/${w.ids.aprB}/documents`)).expect(201)).body;
    expect(aprDoc.verificationCode).toMatch(/^[A-Z2-7]{24}$/);
    expect(aprDoc.sequence).toBe(1);
    const file = await asB(http.get(`/documents/${aprDoc.id}/file`)).buffer(true).parse(binary).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['cache-control']).toContain('no-store');
    const buf = file.body as Buffer;
    expect(createHash('sha256').update(buf).digest('hex')).toBe(aprDoc.sha256);
    const text = pdfText(buf);
    expect(text).toContain('APR-2026-000001');
    expect(text).toContain(aprDoc.verificationCode);
    expect(text).toContain('SITUAÇÃO NA EMISSÃO: APROVADA');
    expect(text).toContain('Cinto inspecionado?');
    expect(text).toContain('22.222.222/0001-82');
    expect(text).toMatch(/Página 1 de \d/);
    expect(text).toContain('Evidências fotográficas');
    // PDF/A declarado e estrutura válida.
    expect(buf.toString('latin1')).toContain('pdfaid:part');
    execFileSync('qpdf', ['--check', toFile(buf)]);
    if (process.env.KEEP_PDF) writeFileSync(process.env.KEEP_PDF, buf);
  });

  it('nova emissão gera outro código e outra sequência; o arquivo anterior continua igual', async () => {
    const second = (await asB(http.post(`/aprs/${w.ids.aprB}/documents`)).expect(201)).body;
    expect(second.sequence).toBe(2);
    expect(second.verificationCode).not.toBe(aprDoc.verificationCode);
    const list = (await asB(http.get('/documents').query({ documentType: 'apr', documentId: w.ids.aprB })).expect(200)).body;
    expect(list.map((d: { sequence: number }) => d.sequence)).toEqual([2, 1]);
    expect(list[1].issuedBy).toBe('adminB (fictício)');
    const again = await asB(http.get(`/documents/${aprDoc.id}/file`)).buffer(true).parse(binary).expect(200);
    expect(createHash('sha256').update(again.body as Buffer).digest('hex')).toBe(aprDoc.sha256);
  });

  it('registra emissão e cada download na auditoria', async () => {
    const ev = (await asB(http.get('/audit-events')).expect(200)).body as { action: string }[];
    const actions = ev.map((e) => e.action);
    expect(actions.filter((a) => a === 'document.issue')).toHaveLength(2);
    expect(actions.filter((a) => a === 'document.download')).toHaveLength(2);
  });

  it('PT em rascunho sai com aviso de que não vale como autorização', async () => {
    const d = (await asB(http.post(`/work-permits/${w.ids.ptB}/documents`)).expect(201)).body;
    const file = await asB(http.get(`/documents/${d.id}/file`)).buffer(true).parse(binary).expect(200);
    const text = pdfText(file.body as Buffer);
    expect(text).toContain('PT-2026-000001');
    expect(text).toContain('NÃO VALE COMO AUTORIZAÇÃO');
    // Só caracteres que a fonte embutida tem (antes, ≥ e ≤ saíam como quadrados).
    expect(text).not.toMatch(/[≥≤]/);
    expect(text).toContain('SITUAÇÃO NA EMISSÃO: EM RASCUNHO');
  });

  it('o registro de emissão é imutável no banco', async () => {
    await expect(withContext(w.owner, { tenantId: w.ids.beta }, (tx) =>
      tx.updateTable('issued_documents').set({ status_at_issue: 'X' }).where('id', '=', aprDoc.id).execute())).rejects.toThrow();
    await expect(withContext(w.owner, { tenantId: w.ids.beta }, (tx) =>
      tx.deleteFrom('issued_documents').where('id', '=', aprDoc.id).execute())).rejects.toThrow();
  });

  it('arquivo adulterado no armazenamento não é entregue', async () => {
    const key = (await withContext(w.owner, { tenantId: w.ids.beta }, (tx) =>
      tx.selectFrom('issued_documents').select('storage_key').where('id', '=', aprDoc.id).executeTakeFirstOrThrow())).storage_key;
    writeFileSync(join(w.storageDir, key), Buffer.from('%PDF-1.7 adulterado'));
    await asB(http.get(`/documents/${aprDoc.id}/file`)).expect(500);
  });

  describe('verificação pública pelo QR Code', () => {
    it('não exige login e não mostra dados pessoais nem conteúdo', async () => {
      const r = await http.get(`/verify/${aprDoc.verificationCode}`).expect(200);
      expect(r.body).toMatchObject({ documentType: 'apr', documentNumber: 'APR-2026-000001', company: 'Beta', currentStatus: 'APPROVED', currentlyValid: true });
      const text = JSON.stringify(r.body);
      for (const secret of ['Segredo da Beta', 'Telhado Beta', 'adminB', 'fictício', 'Trabalhador', w.ids.aprB!, w.ids.adminB!]) expect(text).not.toContain(secret);
    });

    it('PT que não está liberada aparece como não válida', async () => {
      const list = (await asB(http.get('/documents').query({ documentType: 'work_permit', documentId: w.ids.ptB })).expect(200)).body;
      const r = await http.get(`/verify/${list[0].verificationCode}`).expect(200);
      expect(r.body).toMatchObject({ documentType: 'work_permit', currentStatus: 'DRAFT', currentlyValid: false });
      expect(JSON.stringify(r.body)).not.toContain('Tanque Beta');
    });

    it('código inexistente ou malformado: 404', async () => {
      await http.get('/verify/AAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
      await http.get('/verify/abc').expect(404);
      await http.get("/verify/' OR 1=1 --").expect(404);
    });
  });
});

describe('guarda de documentos', () => {
  it('sem regra cadastrada, nada é elegível e nada é apagado', async () => {
    const r = (await asB(http.get('/retention/report')).expect(200)).body;
    expect(r.automaticDeletion).toBe(false);
    expect(r.summary.ELIGIBLE_FOR_REVIEW).toBeUndefined();
    const pt = r.items.find((i: { documentId: string }) => i.documentId === w.ids.ptB);
    expect(pt.situation).toBe('NOT_FINAL');
  });

  it('regra: validação, desativação única e regra legal não desativável', async () => {
    await asB(http.post('/retention-rules')).send({ documentType: 'apr', minYears: 0, source: 'INTERNAL', basis: 'Política interna' }).expect(400);
    await asB(http.post('/retention-rules')).send({ documentType: 'apr', ptTypeName: 'X', minYears: 5, source: 'INTERNAL', basis: 'Política interna' }).expect(400);
    const internal = (await asB(http.post('/retention-rules')).send({ documentType: 'apr', minYears: 5, source: 'INTERNAL', basis: 'Política interna fictícia' }).expect(201)).body;
    const legal = (await asB(http.post('/retention-rules')).send({ documentType: 'work_permit', minYears: 20, source: 'LEGAL', basis: 'Fundamento informado pelo jurídico (teste)' }).expect(201)).body;
    await asB(http.post(`/retention-rules/${internal.id}/deactivate`)).expect(200);
    await asB(http.post(`/retention-rules/${internal.id}/deactivate`)).expect(400);
    await asB(http.post(`/retention-rules/${legal.id}/deactivate`)).expect(400);
    // O banco também impede, mesmo para o dono do schema.
    await expect(withContext(w.owner, { tenantId: w.ids.beta }, (tx) =>
      tx.updateTable('retention_rules').set({ active: false, deactivated_by: w.ids.adminB!, deactivated_at: new Date() }).where('id', '=', legal.id).execute())).rejects.toThrow();
    await expect(withContext(w.owner, { tenantId: w.ids.beta }, (tx) => tx.deleteFrom('retention_rules').where('id', '=', internal.id).execute())).rejects.toThrow();
  });

  it('retenção especial: cria, libera uma vez com justificativa e não pode ser apagada', async () => {
    const h = (await asB(http.post('/legal-holds')).send({ documentType: 'work_permit', documentId: w.ids.ptB, reason: 'Processo fictício em andamento' }).expect(201)).body;
    let r = (await asB(http.get('/retention/report')).expect(200)).body;
    expect(r.items.find((i: { documentId: string }) => i.documentId === w.ids.ptB).situation).toBe('LEGAL_HOLD');
    await asB(http.post(`/legal-holds/${h.id}/release`)).send({ reason: 'x' }).expect(400);
    await asB(http.post(`/legal-holds/${h.id}/release`)).send({ reason: 'Processo encerrado (fictício)' }).expect(200);
    await asB(http.post(`/legal-holds/${h.id}/release`)).send({ reason: 'Processo encerrado (fictício)' }).expect(400);
    r = (await asB(http.get('/retention/report')).expect(200)).body;
    expect(r.items.find((i: { documentId: string }) => i.documentId === w.ids.ptB).situation).toBe('NOT_FINAL');
    await expect(withContext(w.owner, { tenantId: w.ids.beta }, (tx) => tx.deleteFrom('legal_holds').where('id', '=', h.id).execute())).rejects.toThrow();
  });

  it('elegibilidade: só depois de todos os prazos aplicáveis, a partir da data final', async () => {
    const { RetentionController } = await import('../src/documents/retention.controller');
    const ctl = new RetentionController(undefined as never);
    // APR aprovada há 6 anos; regras ativas de 5 (desativada acima) e nenhuma outra → sem regra ativa.
    await withContext(w.owner, { tenantId: w.ids.beta }, async (tx) => {
      await sql`ALTER TABLE aprs DISABLE TRIGGER USER`.execute(tx);
      await tx.updateTable('aprs').set({ decided_at: new Date('2020-01-01T00:00:00Z') }).where('id', '=', w.ids.aprB!).execute();
      await sql`ALTER TABLE aprs ENABLE TRIGGER USER`.execute(tx);
    });
    const at = (d: string) => withContext(w.owner, { tenantId: w.ids.beta }, (tx) => ctl.buildReport(tx, new Date(d)));
    const apr = async (d: string) => (await at(d)).items.find((i) => i.documentId === w.ids.aprB)!;
    expect((await apr('2026-11-09')).situation).toBe('NO_RULE');
    await withContext(w.owner, { tenantId: w.ids.beta }, (tx) => tx.insertInto('retention_rules').values([
      { tenant_id: w.ids.beta!, document_type: 'apr', min_years: 5, source: 'CONTRACT', basis: 'Contrato fictício', created_by: w.ids.adminB! },
      { tenant_id: w.ids.beta!, document_type: 'apr', min_years: 10, source: 'INTERNAL', basis: 'Política fictícia', created_by: w.ids.adminB! },
    ]).execute());
    expect((await apr('2026-11-09')).situation).toBe('RETAINED');
    expect((await apr('2026-11-09')).retainUntil).toEqual(new Date('2030-01-01T00:00:00Z'));
    expect((await apr('2030-01-02')).situation).toBe('ELIGIBLE_FOR_REVIEW');
  });

  it('auditor lê, mas não cadastra regras', async () => {
    const auditor = `Bearer ${await token({ sub: 'sub-auditA' })}`;
    await http.get('/retention-rules').set('Authorization', auditor).set('X-Tenant-Id', w.ids.alfa!).expect(200);
    await http.post('/retention-rules').set('Authorization', auditor).set('X-Tenant-Id', w.ids.alfa!)
      .send({ documentType: 'apr', minYears: 5, source: 'INTERNAL', basis: 'Política interna' }).expect(403);
  });
});
