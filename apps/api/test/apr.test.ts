import sharp from 'sharp';
import request from 'supertest';
import { createWorld, destroyWorld, MATRIX, token, World } from './setup';

let w: World;
let http: ReturnType<typeof request>;
const as = async (user: string) => `Bearer ${await token({ sub: `sub-${user}` })}`;
const A = () => w.ids.alfa!;
const api = async (user: string) => {
  const auth = await as(user);
  const h = (r: request.Test) => r.set('Authorization', auth).set('X-Tenant-Id', A());
  return {
    get: (u: string) => h(http.get(u)),
    post: (u: string) => h(http.post(u)),
    put: (u: string) => h(http.put(u)),
    patch: (u: string) => h(http.patch(u)),
    del: (u: string) => h(http.delete(u)),
  };
};

let jpeg: Buffer;
let matrixId: string;
let versionId: string;
let templateId: string;
let q: { epi: string; area: string; energia: string };

const QUESTIONS = [
  { text: 'Os EPIs exigidos foram verificados?', expectedAnswer: 'YES', criticality: 'HIGH', required: true, allowNa: false,
    justificationOn: ['MISMATCH'], photosRequired: 1, photosMax: 3, mismatchEffect: 'PENDING', normativeRef: 'NR-06' },
  { text: 'A área está sinalizada e isolada?', expectedAnswer: 'YES', criticality: 'CRITICAL', required: true, allowNa: false,
    justificationOn: ['MISMATCH'], photosRequired: 0, photosMax: 5, mismatchEffect: 'BLOCK' },
  // Aqui "Sim" é a resposta INSEGURA: o sistema não presume que Sim é sempre o esperado.
  { text: 'Há linhas energizadas próximas ao local?', expectedAnswer: 'NO', criticality: 'MEDIUM', required: true, allowNa: true,
    justificationOn: ['YES'], photosRequired: 0, photosMax: 0, mismatchEffect: 'ALERT' },
];

const goodAnalysis = (analysisVersion: number) => ({
  analysisVersion,
  steps: [{
    description: 'Montagem do andaime',
    hazards: [{
      hazard: 'Queda de altura', consequence: 'Fraturas, morte', probability: 4, severity: 5, residualProbability: 1, residualSeverity: 4,
      controls: [
        { description: 'Andaime com guarda-corpo', type: 'ENGINEERING', responsibleName: 'Encarregado' },
        { description: 'Cinto paraquedista com duplo talabarte', type: 'PPE' },
      ],
    }],
  }],
});

beforeAll(async () => {
  w = await createWorld();
  http = request(w.app.getHttpServer());
  jpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#3a6' } })
    .withExif({ IFD0: { Make: 'CameraTeste' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '22/1 49/1 0/1' } })
    .jpeg().toBuffer();
});
afterAll(async () => destroyWorld(w));

describe('matriz de risco', () => {
  it('recusa matriz com pontuação sem classe', async () => {
    const sst = await api('sstA');
    const res = await sst.post('/risk-matrices').send({ ...MATRIX, name: 'Furada', classes: MATRIX.classes.slice(0, 3) }).expect(400);
    expect(res.body.code).toBe('INVALID_MATRIX');
  });

  it('executante não cria matriz', async () => {
    await (await api('execA')).post('/risk-matrices').send({ ...MATRIX, name: 'X' }).expect(403);
  });

  it('SST cria e publica', async () => {
    const sst = await api('sstA');
    const m = await sst.post('/risk-matrices').send({ ...MATRIX, name: 'Matriz 5x5' }).expect(201);
    matrixId = m.body.id;
    await sst.post(`/risk-matrices/${matrixId}/publish`).expect(201);
    await sst.post(`/risk-matrices/${matrixId}/publish`).expect(404);
  });
});

describe('modelos de APR', () => {
  it('SST cria o modelo e as perguntas', async () => {
    const sst = await api('sstA');
    const t = await sst.post('/apr-templates').send({ name: 'Trabalho em altura', serviceType: 'altura' }).expect(201);
    templateId = t.body.id;
    versionId = t.body.version.id;
    const bad = await sst.put(`/apr-template-versions/${versionId}/questions`)
      .send({ questions: [{ ...QUESTIONS[1], mismatchEffect: 'ALERT' }] }).expect(400);
    expect(bad.body.fields[0].field).toBe('questions.0.mismatchEffect');
    await sst.put(`/apr-template-versions/${versionId}/questions`).send({ questions: QUESTIONS }).expect(200);
    const v = await sst.get(`/apr-template-versions/${versionId}`).expect(200);
    q = { epi: v.body.questions[0].id, area: v.body.questions[1].id, energia: v.body.questions[2].id };
  });

  it('não cria APR com modelo não publicado', async () => {
    await (await api('execA')).post('/aprs')
      .send({ templateVersionId: versionId, riskMatrixId: matrixId, unitId: w.ids.unitA1, activityDate: '2026-11-10' }).expect(400);
  });

  it('quem escreveu não revisa; publicação exige identificar o profissional', async () => {
    await (await api('sstA')).post(`/apr-template-versions/${versionId}/submit`).expect(201);
    await (await api('sstA')).post(`/apr-template-versions/${versionId}/review`).send({ approve: true,
      professionalValidation: { name: 'X', registry: 'Y', date: '2026-11-09' } }).expect(403);
    const missing = await (await api('sst2A')).post(`/apr-template-versions/${versionId}/review`).send({ approve: true }).expect(400);
    expect(missing.body.fields[0].field).toBe('professionalValidation');
    await (await api('sst2A')).post(`/apr-template-versions/${versionId}/review`).send({
      approve: true, professionalValidation: { name: 'Eng. de Segurança (fictício)', registry: 'CREA-SP 0000000', date: '2026-11-09' },
    }).expect(201);
  });

  it('versão publicada não muda; mudança exige nova versão', async () => {
    const sst = await api('sstA');
    const res = await sst.put(`/apr-template-versions/${versionId}/questions`).send({ questions: QUESTIONS }).expect(400);
    expect(res.body.code).toBe('NOT_DRAFT');
    const v2 = await sst.post(`/apr-templates/${templateId}/versions`).expect(201);
    expect(v2.body.version).toBe(2);
    const copy = await sst.get(`/apr-template-versions/${v2.body.id}`).expect(200);
    expect(copy.body.questions).toHaveLength(3);
    await sst.post(`/apr-templates/${templateId}/versions`).expect(400);
  });
});

describe('APR — preenchimento', () => {
  let aprId: string;
  let ver: Record<string, number>;

  it('supervisor da A1 não cria APR na A2', async () => {
    await (await api('supA1')).post('/aprs')
      .send({ templateVersionId: versionId, riskMatrixId: matrixId, unitId: w.ids.unitA2, activityDate: '2026-11-10' }).expect(403);
  });

  it('executante cria a APR com número sequencial', async () => {
    const res = await (await api('execA')).post('/aprs').send({
      templateVersionId: versionId, riskMatrixId: matrixId, unitId: w.ids.unitA1, activityDate: '2026-11-10',
    }).expect(201);
    aprId = res.body.id;
    expect(res.body.number).toBe('APR-2026-000001');
    ver = {};
  });

  it('a verificação começa com todas as pendências', async () => {
    const res = await (await api('execA')).get(`/aprs/${aprId}/check`).expect(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.progress).toEqual({ answered: 0, total: 3 });
    const codes = res.body.blocking.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['LOCATION_REQUIRED', 'TEAM_REQUIRED', 'ANSWER_REQUIRED', 'STEPS_REQUIRED']));
  });

  it('cabeçalho usa controle de versão', async () => {
    const ex = await api('execA');
    const r = await ex.patch(`/aprs/${aprId}`).send({ rowVersion: 1, location: 'Galpão 3, cobertura', serviceDescription: 'Troca de telhas',
      responsibleName: 'Edson (fictício)', team: [{ name: 'Edson (fictício)' }, { name: 'Caio (fictício)' }], equipment: ['Andaime'] }).expect(200);
    expect(r.body.rowVersion).toBe(2);
    await ex.patch(`/aprs/${aprId}`).send({ rowVersion: 1, location: 'outro' }).expect(409);
  });

  it('N/A é recusado onde não é permitido', async () => {
    const res = await (await api('execA')).put(`/aprs/${aprId}/answers/${q.epi}`).send({ answer: 'NA' }).expect(400);
    expect(res.body.code).toBe('NA_NOT_ALLOWED');
  });

  it('salva rascunho incompleto e aponta o que falta', async () => {
    const ex = await api('execA');
    const r = await ex.put(`/aprs/${aprId}/answers/${q.epi}`).send({ answer: 'NO' }).expect(200);
    ver.epi = r.body.version;
    const check = await ex.get(`/aprs/${aprId}/check`).expect(200);
    const epiIssues = check.body.blocking.filter((i: { questionId: string }) => i.questionId === q.epi).map((i: { code: string }) => i.code);
    expect(epiIssues.sort()).toEqual(['CORRECTIVE_ACTION_REQUIRED', 'JUSTIFICATION_REQUIRED', 'PHOTOS_REQUIRED']);
  });

  it('detecta edição concorrente da mesma resposta', async () => {
    const ex = await api('execA');
    await ex.put(`/aprs/${aprId}/answers/${q.epi}`).send({ answer: 'YES' }).expect(409);
    const send = () => ex.put(`/aprs/${aprId}/answers/${q.epi}`).send({ answer: 'YES', version: ver.epi });
    const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    ver.epi! += 1;
  });

  it('"Sim" onde o esperado é "Não" gera alerta e pede justificativa', async () => {
    const ex = await api('execA');
    const first = await ex.put(`/aprs/${aprId}/answers/${q.energia}`).send({ answer: 'YES' }).expect(200);
    const check = await ex.get(`/aprs/${aprId}/check`).expect(200);
    expect(check.body.warnings.map((i: { code: string }) => i.code)).toContain('MISMATCH_ALERT');
    expect(check.body.blocking.find((i: { questionId: string }) => i.questionId === q.energia).code).toBe('JUSTIFICATION_REQUIRED');
    const r = await ex.put(`/aprs/${aprId}/answers/${q.energia}`).send({ answer: 'YES', version: first.body.version, justification: 'Rede de 13,8 kV a 6 m; desligamento solicitado à concessionária' }).expect(200);
    ver.energia = r.body.version;
  });

  it('pergunta crítica com "Não" exige ação corretiva e nova avaliação por outra pessoa', async () => {
    const ex = await api('execA');
    const sup = await api('supA1');
    let r = await ex.put(`/aprs/${aprId}/answers/${q.area}`).send({ answer: 'NO', justification: 'Fita rompida' }).expect(200);
    await sup.post(`/aprs/${aprId}/answers/${q.area}/reassess`).send({ answer: 'YES', version: r.body.version }).expect(400);
    r = await ex.put(`/aprs/${aprId}/answers/${q.area}`).send({ answer: 'NO', justification: 'Fita rompida', correctiveAction: 'Isolamento refeito com grade', version: r.body.version }).expect(200);
    let check = await ex.get(`/aprs/${aprId}/check`).expect(200);
    expect(check.body.blocking.find((i: { questionId: string }) => i.questionId === q.area).code).toBe('REASSESSMENT_REQUIRED');
    await ex.post(`/aprs/${aprId}/answers/${q.area}/reassess`).send({ answer: 'YES', version: r.body.version }).expect(403);
    const failed = await sup.post(`/aprs/${aprId}/answers/${q.area}/reassess`).send({ answer: 'NO', version: r.body.version }).expect(200);
    check = await ex.get(`/aprs/${aprId}/check`).expect(200);
    expect(check.body.blocking.find((i: { questionId: string }) => i.questionId === q.area).code).toBe('REASSESSMENT_FAILED');
    await sup.post(`/aprs/${aprId}/answers/${q.area}/reassess`).send({ answer: 'YES', version: failed.body.version }).expect(200);
    check = await ex.get(`/aprs/${aprId}/check`).expect(200);
    expect(check.body.blocking.filter((i: { questionId: string }) => i.questionId === q.area)).toEqual([]);
  });

  describe('fotos', () => {
    const up = async (user: string, question: string, buf: Buffer, name = 'foto.jpg') =>
      (await api(user)).post(`/aprs/${aprId}/questions/${question}/photos`).attach('file', buf, name);

    it('recusa arquivo que não é imagem, mesmo com extensão .jpg', async () => {
      const res = await up('execA', q.epi, Buffer.from('<?php system($_GET["c"]); ?>'), 'foto.jpg');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_TYPE');
    });

    it('recusa imagem corrompida com cabeçalho JPEG', async () => {
      const res = await up('execA', q.epi, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IMAGE');
    });

    it('recusa HEIC com orientação clara', async () => {
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
      const res = await up('execA', q.epi, heic, 'IMG_0001.HEIC');
      expect(res.body.code).toBe('HEIC_NOT_SUPPORTED');
    });

    it('recusa foto em pergunta que não recebe fotos', async () => {
      const res = await up('execA', q.energia, jpeg);
      expect(res.body.code).toBe('PHOTOS_NOT_ALLOWED');
    });

    it('guarda original íntegro e cópia de exibição sem EXIF/GPS e reduzida', async () => {
      const res = await up('execA', q.epi, jpeg);
      expect(res.status).toBe(201);
      const { createHash } = await import('node:crypto');
      expect(res.body.sha256).toBe(createHash('sha256').update(jpeg).digest('hex'));
      const display = await (await api('execA')).get(`/aprs/${aprId}/photos/${res.body.id}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(display.headers['content-type']).toBe('image/jpeg');
      expect(display.headers['cache-control']).toBe('private, no-store');
      const meta = await sharp(display.body as Buffer).metadata();
      expect(meta.exif).toBeUndefined();
      expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    });

    it('original: executante não baixa; supervisor baixa com hash', async () => {
      const apr = await (await api('execA')).get(`/aprs/${aprId}`).expect(200);
      const photoId = apr.body.photos[0].id;
      await (await api('execA')).get(`/aprs/${aprId}/photos/${photoId}/original`).expect(403);
      const res = await (await api('supA1')).get(`/aprs/${aprId}/photos/${photoId}/original`).expect(200);
      expect(res.headers['x-content-sha256']).toBe(apr.body.photos[0].sha256);
    });

    it('limite de 3 fotos vale mesmo com envios simultâneos', async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() => up('execA', q.epi, jpeg)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 400, 400]);
      const apr = await (await api('execA')).get(`/aprs/${aprId}`).expect(200);
      expect(apr.body.photos.filter((p: { questionId: string }) => p.questionId === q.epi)).toHaveLength(3);
    });

    it('remove foto antes do envio, liberando a vaga', async () => {
      const apr = await (await api('execA')).get(`/aprs/${aprId}`).expect(200);
      await (await api('execA')).del(`/aprs/${aprId}/photos/${apr.body.photos[2].id}`).expect(204);
      await (await api('execA')).del(`/aprs/${aprId}/photos/${apr.body.photos[2].id}`).expect(404);
      expect((await up('execA', q.epi, jpeg)).status).toBe(201);
    });
  });

  describe('análise de riscos', () => {
    it('recusa valores fora da matriz', async () => {
      const a = goodAnalysis(1);
      a.steps[0]!.hazards[0]!.probability = 9;
      const res = await (await api('execA')).put(`/aprs/${aprId}/analysis`).send(a).expect(400);
      expect(res.body.fields[0].field).toBe('steps.0.hazards.0.probability');
    });

    it('risco residual inaceitável bloqueia', async () => {
      const a = goodAnalysis(1);
      a.steps[0]!.hazards[0]!.residualProbability = 3;
      const r = await (await api('execA')).put(`/aprs/${aprId}/analysis`).send(a).expect(200);
      ver.analysis = r.body.analysisVersion;
      const check = await (await api('execA')).get(`/aprs/${aprId}/check`).expect(200);
      expect(check.body.blocking.map((i: { code: string }) => i.code)).toContain('RESIDUAL_UNACCEPTABLE');
    });

    it('versão desatualizada da análise dá conflito', async () => {
      await (await api('execA')).put(`/aprs/${aprId}/analysis`).send(goodAnalysis(1)).expect(409);
    });

    it('com controles adequados, a APR fica pronta', async () => {
      const ex = await api('execA');
      await ex.put(`/aprs/${aprId}/analysis`).send(goodAnalysis(ver.analysis!)).expect(200);
      await ex.put(`/aprs/${aprId}/answers/${q.epi}`).send({
        answer: 'NO', version: ver.epi, justification: 'Faltava luva isolante', correctiveAction: 'Luvas entregues e conferidas',
      }).expect(200);
      const check = await ex.get(`/aprs/${aprId}/check`).expect(200);
      expect(check.body.blocking).toEqual([]);
      expect(check.body.ready).toBe(true);
      const full = await ex.get(`/aprs/${aprId}`).expect(200);
      expect(full.body.steps[0].hazards[0].initial).toEqual({ score: 20, label: 'Crítico', acceptable: false });
      expect(full.body.steps[0].hazards[0].residual).toEqual({ score: 4, label: 'Baixo', acceptable: true });
    });
  });

  describe('envio e aprovação', () => {
    it('envia para revisão e trava a edição', async () => {
      const ex = await api('execA');
      await ex.post(`/aprs/${aprId}/submit`).expect(200);
      expect((await ex.put(`/aprs/${aprId}/answers/${q.energia}`).send({ answer: 'NO', version: ver.energia })).body.code).toBe('APR_NOT_EDITABLE');
      expect((await ex.post(`/aprs/${aprId}/questions/${q.epi}/photos`).attach('file', jpeg, 'f.jpg')).body.code).toBe('APR_NOT_EDITABLE');
    });

    it('executante não aprova; supervisor aprova', async () => {
      await (await api('execA')).post(`/aprs/${aprId}/approve`).send({}).expect(403);
      const res = await (await api('supA1')).post(`/aprs/${aprId}/approve`).send({ note: 'Conferido em campo' }).expect(200);
      expect(res.body.status).toBe('APPROVED');
    });

    it('APR aprovada não muda', async () => {
      const r = await (await api('execA')).patch(`/aprs/${aprId}`).send({ rowVersion: 4, location: 'x' });
      expect(r.status).toBe(400);
      await (await api('execA')).post(`/aprs/${aprId}/cancel`).send({ note: 'x' }).expect(400);
    });

    it('revisão gera nova APR com o mesmo número e exige fotos e nova avaliação de novo', async () => {
      const rev = await (await api('execA')).post(`/aprs/${aprId}/revise`).expect(201);
      expect(rev.body).toMatchObject({ number: 'APR-2026-000001', revision: 1, status: 'DRAFT' });
      const check = await (await api('execA')).get(`/aprs/${rev.body.id}/check`).expect(200);
      expect(check.body.blocking.map((i: { code: string }) => i.code).sort()).toEqual(['PHOTOS_REQUIRED', 'REASSESSMENT_REQUIRED']);
      await (await api('execA')).post(`/aprs/${aprId}/revise`).expect(400);
    });

    it('o histórico mostra a sequência de ações', async () => {
      const res = await (await api('auditA')).get(`/aprs/${aprId}/history`).expect(200);
      const actions = res.body.map((e: { action: string }) => e.action);
      expect(actions[0]).toBe('apr.create');
      expect(actions).toEqual(expect.arrayContaining(['apr.answer', 'apr.reassess', 'apr.photo_add', 'apr.photo_remove', 'apr.analysis', 'apr.submit', 'apr.approve']));
      expect(actions.at(-1)).toBe('apr.approve');
    });
  });
});

describe('APR — não pronta, devolução e cancelamento', () => {
  let id: string;

  it('envio com pendências devolve a lista', async () => {
    const ex = await api('execA');
    id = (await ex.post('/aprs').send({ templateVersionId: versionId, riskMatrixId: matrixId, unitId: w.ids.unitA1, activityDate: '2026-11-11' }).expect(201)).body.id;
    const res = await ex.post(`/aprs/${id}/submit`).expect(422);
    expect(res.body.code).toBe('APR_NOT_READY');
    expect(res.body.blocking.length).toBeGreaterThan(3);
  });

  it('quem criou não aprova a própria APR', async () => {
    const sup = await api('supA1');
    const own = (await sup.post('/aprs').send({ templateVersionId: versionId, riskMatrixId: matrixId, unitId: w.ids.unitA1, activityDate: '2026-11-11' }).expect(201)).body.id;
    // Força o estado de revisão direto no banco para testar só a regra de aprovação.
    const { withContext } = await import('@sitedopai/db');
    await withContext(w.owner, { tenantId: A() }, (tx) => tx.updateTable('aprs').set({ status: 'IN_REVIEW' }).where('id', '=', own).execute());
    const res = await sup.post(`/aprs/${own}/approve`).send({}).expect(403);
    expect(res.body.message).toMatch(/criou/);
  });

  it('devolução exige motivo e reabre a edição', async () => {
    const { withContext } = await import('@sitedopai/db');
    await withContext(w.owner, { tenantId: A() }, (tx) => tx.updateTable('aprs').set({ status: 'IN_REVIEW' }).where('id', '=', id).execute());
    const sup = await api('supA1');
    await sup.post(`/aprs/${id}/return`).send({}).expect(400);
    await sup.post(`/aprs/${id}/return`).send({ note: 'Descrever as etapas' }).expect(200);
    await (await api('execA')).put(`/aprs/${id}/answers/${q.energia}`).send({ answer: 'NO' }).expect(200);
  });

  it('cancelamento exige motivo', async () => {
    const ex = await api('execA');
    await ex.post(`/aprs/${id}/cancel`).send({}).expect(400);
    await ex.post(`/aprs/${id}/cancel`).send({ note: 'Serviço adiado' }).expect(200);
    expect((await ex.get(`/aprs/${id}`).expect(200)).body.status).toBe('CANCELLED');
  });

  it('lista respeita o escopo: supervisor da A1 não vê APR de outra unidade', async () => {
    const list = await (await api('supA1')).get('/aprs').expect(200);
    expect(list.body.every((a: { unit_id: string }) => a.unit_id === w.ids.unitA1)).toBe(true);
  });
});
