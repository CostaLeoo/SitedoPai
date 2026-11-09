import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { ANSWERS, audit, GasParameter, PtStatus, sql, TEAM_FUNCTIONS, Tx } from '@sitedopai/db';
import { canOnUnit, unitScope } from '../authz/permissions';
import { staleVersion } from '../apr/apr.service';
import { isMismatch } from '../apr/rules';
import { Auth, RequirePermission, Tenant, AllowWhenRestricted } from '../common/decorators';
import { forbidden, notFound, requireUnit } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { canonicalJson, sha256, SignatureService } from '../common/signature';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';
import { PtService } from '../pt/pt.service';
import { coversPeriod, Stage, withinLimits } from '../pt/rules';

const iso = z.string().datetime({ offset: true, message: 'Use data e hora ISO 8601' });
const create = z.strictObject({
  ptTypeId: z.string().uuid(),
  aprId: z.string().uuid(),
  sectorId: z.string().uuid().optional(),
  location: z.string().trim().min(1, 'Informe o local').max(300),
  description: z.string().trim().min(1, 'Descreva a atividade').max(4000),
  startsAt: iso,
  endsAt: iso,
}).refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { path: ['endsAt'], message: 'O fim precisa ser depois do início' });
const patch = z.strictObject({
  rowVersion: z.number().int().positive(),
  sectorId: z.string().uuid().nullable().optional(),
  location: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  startsAt: iso.optional(),
  endsAt: iso.optional(),
});
const team = z.strictObject({
  rowVersion: z.number().int().positive(),
  members: z.array(z.strictObject({ workerId: z.string().uuid(), function: z.enum(TEAM_FUNCTIONS) })).max(100),
});
const answer = z.strictObject({
  answer: z.enum(ANSWERS),
  justification: z.string().trim().max(2000).nullable().optional(),
  correctiveAction: z.string().trim().max(2000).nullable().optional(),
  version: z.number().int().positive().optional(),
});
const reassess = z.strictObject({ answer: z.enum(ANSWERS), version: z.number().int().positive() });
const review = z.strictObject({ approve: z.boolean(), note: z.string().trim().max(2000).optional() })
  .refine((r) => r.approve || !!r.note, { path: ['note'], message: 'Explique o que precisa ser corrigido' });
const reason = z.strictObject({ reason: z.string().trim().min(1, 'Informe o motivo').max(2000) });
const measurement = z.strictObject({
  parameterKey: z.string().min(1).max(30),
  value: z.number().finite(),
  instrument: z.string().trim().min(1, 'Identifique o instrumento (modelo e número de série)').max(200),
});
const entry = z.strictObject({ workerId: z.string().uuid() });
const close = z.strictObject({
  notes: z.string().trim().max(2000).optional(),
  areaReleased: z.literal(true, { error: 'Confirme que a área foi liberada' }),
  teamOut: z.literal(true, { error: 'Confirme que toda a equipe saiu' }),
});

const EDITABLE: PtStatus[] = ['DRAFT', 'AWAITING_CORRECTION'];
const bad = (code: string, message: string) => new BadRequestException({ code, message });
const notReady = (r: { blocking: unknown[]; warnings: unknown[] }) =>
  new UnprocessableEntityException({ code: 'PT_NOT_READY', message: 'A PT tem pendências que impedem o avanço.', blocking: r.blocking, warnings: r.warnings });

@Controller('work-permits')
export class WorkPermitsController {
  constructor(private readonly db: DbService, private readonly svc: PtService, private readonly sig: SignatureService) {}

  /** Toda rota de PT começa marcando as vencidas como expiradas. */
  private run<T>(auth: AuthContext, t: TenantContext, fn: (tx: Tx) => Promise<T>) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await this.svc.syncExpiry(tx, t.tenantId);
      return fn(tx);
    });
  }

  private async scoped(tx: Tx, t: TenantContext, id: string, p: 'pt.read' | 'pt.write' | 'pt.review' | 'pt.release' | 'pt.field', lock = false) {
    if (!uuid.safeParse(id).success) throw notFound('PT');
    const pt = await this.svc.load(tx, id, lock);
    if (!canOnUnit(t.assignments, 'pt.read', pt.unit_id)) throw notFound('PT');
    if (p !== 'pt.read') requireUnit(t, p, pt.unit_id);
    return pt;
  }

  private async me(tx: Tx, auth: AuthContext) {
    const u = await tx.selectFrom('users').select('display_name').where('id', '=', auth.userId).executeTakeFirstOrThrow();
    const w = await tx.selectFrom('workers').select(['id', 'full_name']).where('user_id', '=', auth.userId).executeTakeFirst();
    return { name: w?.full_name ?? u.display_name, workerId: w?.id ?? null };
  }

  private async setStatus(tx: Tx, id: string, rowVersion: number, status: PtStatus, extra: Record<string, unknown> = {}) {
    return tx.updateTable('work_permits').set({ status, row_version: rowVersion + 1, ...extra }).where('id', '=', id)
      .returning(['id', 'status', 'row_version']).executeTakeFirstOrThrow();
  }

  private async noOpenEntries(tx: Tx, id: string) {
    const open = await tx.selectFrom('pt_entries').select('id').where('pt_id', '=', id).where('exited_at', 'is', null).executeTakeFirst();
    if (open) throw bad('PEOPLE_INSIDE', 'Há pessoas com entrada registrada e sem saída. Registre a saída de todos primeiro.');
  }

  // ------------------------------------------------------------------ leitura

  @Get()
  @RequirePermission('pt.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    const scope = unitScope(t.assignments, 'pt.read');
    return this.run(auth, t, async (tx) => {
      let q = tx.selectFrom('work_permits').select(['id', 'number', 'status', 'unit_id', 'location', 'description', 'starts_at', 'ends_at', 'updated_at'])
        .orderBy('starts_at', 'desc').limit(200);
      if (!scope.all) q = scope.unitIds.length ? q.where('unit_id', 'in', scope.unitIds) : q.where(sql<boolean>`false`);
      const rows = await q.execute();
      return rows.map((r) => ({ ...r, validity: this.svc.validity(r) }));
    });
  }

  @Get(':id')
  @RequirePermission('pt.read')
  get(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'pt.read');
      const f = await this.svc.loadFull(tx, id);
      const { tenant_id: _t, ...pt } = f.pt;
      return {
        ...pt,
        validity: this.svc.validity(f.pt),
        type: { id: f.type.id, name: f.type.name, version: f.type.version, maxValidityMinutes: f.type.max_validity_minutes,
          requiresGasMonitoring: f.type.requires_gas_monitoring, gasParameters: f.type.gas_parameters, gasMaxAgeMinutes: f.type.gas_max_age_minutes,
          requiresEntryLog: f.type.requires_entry_log, requirements: f.requirements.map((r) => ({ function: r.function, minCount: r.min_count })) },
        apr: f.apr,
        team: f.team.map((m) => ({ id: m.id, workerId: m.worker_id, userId: m.user_id, name: m.full_name, function: m.function, acknowledged: !!m.acknowledged_signature_id, hasAccount: !!m.user_id })),
        questions: f.questions.map((q) => ({ id: q.id, position: q.position, text: q.text, expectedAnswer: q.expected_answer, criticality: q.criticality,
          required: q.required, allowNa: q.allow_na, justificationOn: q.justification_on, mismatchEffect: q.mismatch_effect, normativeRef: q.normative_ref })),
        answers: f.answers.map((a) => ({ questionId: a.question_id, answer: a.answer, justification: a.justification, correctiveAction: a.corrective_action,
          answeredBy: a.answered_by, reassessedAnswer: a.reassessed_answer, reassessedBy: a.reassessed_by, version: a.version })),
        measurements: f.measurements.map((m) => ({ id: m.id, parameterKey: m.parameter_key, value: Number(m.value), unit: m.unit, withinLimits: m.within_limits, instrument: m.instrument, receivedAt: m.received_at })),
        entries: f.entries,
        signatures: f.signatures.map((s) => ({ id: s.id, meaning: s.meaning, signerName: s.signer_name, signedAt: s.signed_at, hash: s.document_hash })),
      };
    });
  }

  @Get(':id/check')
  @RequirePermission('pt.read')
  check(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.read');
      const stage: Stage = pt.status === 'SUSPENDED' ? 'resume' : ['AWAITING_APPROVAL', 'RELEASED'].includes(pt.status) ? 'release' : 'submit';
      return { stage, ...this.svc.check(await this.svc.loadFull(tx, id), stage) };
    });
  }

  /** Vale como autorização AGORA? Considera situação e prazo. */
  @Get(':id/validity')
  @RequirePermission('pt.read')
  validity(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.read');
      return { number: pt.number, status: pt.status, startsAt: pt.starts_at, endsAt: pt.ends_at, ...this.svc.validity(pt) };
    });
  }

  /** Assinaturas com verificação: o conteúdo guardado ainda bate com o hash, e a PT atual com a última liberação. */
  @Get(':id/signatures')
  @RequirePermission('pt.read')
  signatures(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'pt.read');
      const rows = await tx.selectFrom('signatures').innerJoin('document_snapshots', 'document_snapshots.id', 'signatures.snapshot_id')
        .select(['signatures.id', 'signatures.meaning', 'signatures.signer_name', 'signatures.signer_context', 'signatures.evidence', 'signatures.signed_at',
          'signatures.document_hash', 'document_snapshots.content'])
        .where('signatures.document_type', '=', 'work_permit').where('signatures.document_id', '=', id).orderBy('signatures.signed_at').execute();
      const f = await this.svc.loadFull(tx, id);
      const lastRelease = [...rows].reverse().find((r) => r.meaning === 'RELEASE' || r.meaning === 'RESUME');
      // Recalcula o conteúdo atual como estava no momento da última liberação.
      const currentHash = lastRelease ? sha256(canonicalJson(this.svc.snapshot(f, lastRelease.signed_at))) : null;
      return {
        currentHash,
        unchangedSinceRelease: lastRelease ? lastRelease.document_hash === currentHash : null,
        signatures: rows.map((r) => ({
          id: r.id, meaning: r.meaning, signerName: r.signer_name, signerContext: r.signer_context, evidence: r.evidence,
          signedAt: r.signed_at, hash: r.document_hash, integrity: sha256(r.content) === r.document_hash,
        })),
      };
    });
  }

  @Get(':id/history')
  @RequirePermission('pt.read')
  history(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'pt.read');
      const rows = await tx.selectFrom('audit_events').leftJoin('users', 'users.id', 'audit_events.actor_user_id')
        .select(['audit_events.seq', 'audit_events.occurred_at', 'audit_events.action', 'audit_events.data', 'users.display_name as actor'])
        .where('audit_events.entity_type', '=', 'work_permit').where('audit_events.entity_id', '=', id).orderBy('audit_events.seq').execute();
      return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
    });
  }

  // ------------------------------------------------------------- preparação

  @Post()
  @RequirePermission('pt.write')
  create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    const input = parse(create, body);
    return this.run(auth, t, async (tx) => {
      const apr = await tx.selectFrom('aprs').select(['id', 'status', 'unit_id']).where('id', '=', input.aprId).executeTakeFirst();
      if (!apr || !canOnUnit(t.assignments, 'apr.read', apr.unit_id)) throw bad('INVALID_REFERENCE', 'APR não encontrada.');
      requireUnit(t, 'pt.write', apr.unit_id);
      if (apr.status !== 'APPROVED') throw bad('APR_NOT_APPROVED', 'A PT precisa de uma APR aprovada.');
      const newer = await tx.selectFrom('aprs').select('id').where('previous_revision_id', '=', apr.id).where('status', '=', 'APPROVED').executeTakeFirst();
      if (newer) throw bad('APR_SUPERSEDED', 'Esta APR foi substituída por uma revisão aprovada. Use a revisão atual.');
      const type = await tx.selectFrom('pt_types').select(['status', 'max_validity_minutes']).where('id', '=', input.ptTypeId).executeTakeFirst();
      if (!type || type.status !== 'PUBLISHED') throw bad('INVALID_REFERENCE', 'O tipo de PT precisa estar publicado.');
      const minutes = (new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime()) / 60000;
      if (minutes > type.max_validity_minutes) throw bad('VALIDITY_TOO_LONG', `O período passa da validade máxima deste tipo de PT (${type.max_validity_minutes} min).`);
      const num = await sql<{ n: string }>`SELECT next_pt_number(${new Date(input.startsAt).getUTCFullYear()}) AS n`.execute(tx);
      const pt = await tx.insertInto('work_permits').values({
        tenant_id: t.tenantId, number: num.rows[0]!.n, pt_type_id: input.ptTypeId, apr_id: apr.id, unit_id: apr.unit_id,
        sector_id: input.sectorId ?? null, location: input.location, description: input.description,
        starts_at: input.startsAt, ends_at: input.endsAt, created_by: auth.userId,
      }).returning(['id', 'number', 'status', 'row_version']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.create', entityType: 'work_permit', entityId: pt.id, data: input });
      return pt;
    });
  }

  @Patch(':id')
  @RequirePermission('pt.write')
  update(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const { rowVersion, ...input } = parse(patch, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.write', true);
      if (!EDITABLE.includes(pt.status)) throw bad('PT_NOT_EDITABLE', 'A PT não está em edição.');
      if (pt.row_version !== rowVersion) throw staleVersion('A PT');
      const set: Record<string, unknown> = { row_version: rowVersion + 1 };
      if (input.sectorId !== undefined) set.sector_id = input.sectorId;
      if (input.location !== undefined) set.location = input.location;
      if (input.description !== undefined) set.description = input.description;
      if (input.startsAt !== undefined) set.starts_at = input.startsAt;
      if (input.endsAt !== undefined) set.ends_at = input.endsAt;
      const r = await tx.updateTable('work_permits').set(set).where('id', '=', id).returning(['id', 'row_version']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.update', entityType: 'work_permit', entityId: id, data: input });
      return r;
    });
  }

  @Put(':id/team')
  @RequirePermission('pt.write')
  putTeam(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(team, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.write', true);
      if (!EDITABLE.includes(pt.status)) throw bad('PT_NOT_EDITABLE', 'A PT não está em edição.');
      if (pt.row_version !== input.rowVersion) throw staleVersion('A PT');
      await tx.deleteFrom('pt_team').where('pt_id', '=', id).execute();
      if (input.members.length) {
        await tx.insertInto('pt_team').values(input.members.map((m) => ({ tenant_id: t.tenantId, pt_id: id, worker_id: m.workerId, function: m.function }))).execute();
      }
      const r = await tx.updateTable('work_permits').set({ row_version: pt.row_version + 1 }).where('id', '=', id).returning(['id', 'row_version']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.team', entityType: 'work_permit', entityId: id, data: input });
      return r;
    });
  }

  @Put(':id/answers/:questionId')
  @RequirePermission('pt.write')
  answer(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('questionId') questionId: string, @Body() body: unknown) {
    const input = parse(answer, body);
    if (!uuid.safeParse(questionId).success) throw notFound('Pergunta');
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.write');
      if (!EDITABLE.includes(pt.status)) throw bad('PT_NOT_EDITABLE', 'A PT não está em edição.');
      const q = await tx.selectFrom('apr_template_questions').innerJoin('pt_types', 'pt_types.checklist_template_version_id', 'apr_template_questions.template_version_id')
        .select(['apr_template_questions.id', 'apr_template_questions.allow_na'])
        .where('pt_types.id', '=', pt.pt_type_id).where('apr_template_questions.id', '=', questionId).executeTakeFirst();
      if (!q) throw notFound('Pergunta');
      if (input.answer === 'NA' && !q.allow_na) throw bad('NA_NOT_ALLOWED', 'N/A não é permitido nesta pergunta.');
      const cur = await tx.selectFrom('pt_answers').selectAll().where('pt_id', '=', id).where('question_id', '=', questionId).forUpdate().executeTakeFirst();
      const values = { answer: input.answer, justification: input.justification ?? null, corrective_action: input.correctiveAction ?? null, answered_by: auth.userId, answered_at: new Date() };
      let version: number;
      if (!cur) {
        if (input.version !== undefined) throw staleVersion('A resposta');
        version = (await tx.insertInto('pt_answers').values({ tenant_id: t.tenantId, pt_id: id, question_id: questionId, ...values }).returning('version').executeTakeFirstOrThrow()).version;
      } else {
        if (input.version !== cur.version) throw staleVersion('A resposta');
        const reset = cur.answer !== input.answer || cur.answered_by !== auth.userId ? { reassessed_answer: null, reassessed_by: null, reassessed_at: null } : {};
        version = (await tx.updateTable('pt_answers').set({ ...values, ...reset, version: cur.version + 1 }).where('id', '=', cur.id).returning('version').executeTakeFirstOrThrow()).version;
      }
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.answer', entityType: 'work_permit', entityId: id, data: { questionId, ...input } });
      return { questionId, version };
    });
  }

  @Post(':id/answers/:questionId/reassess')
  @HttpCode(200)
  @RequirePermission('pt.write')
  reassess(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('questionId') questionId: string, @Body() body: unknown) {
    const input = parse(reassess, body);
    if (!uuid.safeParse(questionId).success) throw notFound('Pergunta');
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.write');
      if (![...EDITABLE, 'IN_ANALYSIS'].includes(pt.status)) throw bad('PT_NOT_EDITABLE', 'A PT não está em edição.');
      const row = await tx.selectFrom('pt_answers').innerJoin('apr_template_questions', 'apr_template_questions.id', 'pt_answers.question_id')
        .select(['pt_answers.id', 'pt_answers.answer', 'pt_answers.answered_by', 'pt_answers.corrective_action', 'pt_answers.version',
          'apr_template_questions.expected_answer', 'apr_template_questions.allow_na', 'apr_template_questions.mismatch_effect'])
        .where('pt_answers.pt_id', '=', id).where('pt_answers.question_id', '=', questionId).forUpdate().executeTakeFirst();
      if (!row) throw notFound('Resposta');
      if (row.version !== input.version) throw staleVersion('A resposta');
      if (row.mismatch_effect !== 'BLOCK' || !isMismatch({ expectedAnswer: row.expected_answer, allowNa: row.allow_na }, row.answer)) {
        throw bad('REASSESS_NOT_NEEDED', 'Esta resposta não exige nova avaliação.');
      }
      if (!row.corrective_action?.trim()) throw bad('CORRECTIVE_ACTION_REQUIRED', 'Registre a ação corretiva antes da nova avaliação.');
      if (row.answered_by === auth.userId) throw forbidden('A nova avaliação precisa ser feita por outra pessoa.');
      const v = await tx.updateTable('pt_answers').set({ reassessed_answer: input.answer, reassessed_by: auth.userId, reassessed_at: new Date(), version: row.version + 1 })
        .where('id', '=', row.id).returning('version').executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.reassess', entityType: 'work_permit', entityId: id, data: { questionId, answer: input.answer } });
      return { questionId, version: v.version };
    });
  }

  // ------------------------------------------------------------------ fluxo

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('pt.write')
  submit(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.write', true);
      if (!EDITABLE.includes(pt.status)) throw bad('PT_NOT_EDITABLE', 'A PT não está em edição.');
      const r = this.svc.check(await this.svc.loadFull(tx, id), 'submit');
      if (!r.ready) throw notReady(r);
      const row = await this.setStatus(tx, id, pt.row_version, 'IN_ANALYSIS', { submitted_at: new Date(), status_reason: null });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.submit', entityType: 'work_permit', entityId: id });
      return row;
    });
  }

  /** Análise técnica (SST): segue para aprovação ou volta para correção. */
  @Post(':id/review')
  @HttpCode(200)
  @RequirePermission('pt.review')
  review(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(review, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.review', true);
      if (pt.status !== 'IN_ANALYSIS') throw bad('NOT_IN_ANALYSIS', 'A PT não está em análise.');
      if (pt.created_by === auth.userId) throw forbidden('Quem criou a PT não pode analisá-la.');
      if (input.approve) {
        const r = this.svc.check(await this.svc.loadFull(tx, id), 'submit');
        if (!r.ready) throw notReady(r);
      }
      const row = await this.setStatus(tx, id, pt.row_version, input.approve ? 'AWAITING_APPROVAL' : 'AWAITING_CORRECTION',
        { reviewed_by: auth.userId, reviewed_at: new Date(), status_reason: input.note ?? null });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: input.approve ? 'pt.review_ok' : 'pt.review_correction', entityType: 'work_permit', entityId: id, data: input });
      return row;
    });
  }

  @Post(':id/measurements')
  @AllowWhenRestricted()
  @RequirePermission('pt.field')
  measure(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(measurement, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.field');
      const type = await tx.selectFrom('pt_types').select(['gas_parameters']).where('id', '=', pt.pt_type_id).executeTakeFirstOrThrow();
      const param = (type.gas_parameters as unknown as GasParameter[]).find((p) => p.key === input.parameterKey);
      if (!param) throw bad('UNKNOWN_PARAMETER', 'Parâmetro não previsto para este tipo de PT.');
      if (!['AWAITING_APPROVAL', 'RELEASED', 'IN_EXECUTION', 'SUSPENDED'].includes(pt.status)) {
        throw bad('MEASUREMENT_NOT_ALLOWED', 'Medição não permitida nesta situação da PT.');
      }
      const within = withinLimits(param, input.value);
      const m = await tx.insertInto('pt_measurements').values({
        tenant_id: t.tenantId, pt_id: id, parameter_key: param.key, value: input.value, unit: param.unit,
        within_limits: within, instrument: input.instrument, measured_by: auth.userId,
      }).returning(['id', 'within_limits', 'received_at']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.measure', entityType: 'work_permit', entityId: id, data: { ...input, withinLimits: within } });
      // Fora do limite com a PT em vigor: suspende na hora. Parar é sempre o lado seguro.
      if (!within && (pt.status === 'RELEASED' || pt.status === 'IN_EXECUTION')) {
        await this.setStatus(tx, id, pt.row_version, 'SUSPENDED', { suspended_at: new Date(), status_reason: `${param.label} fora dos limites (${input.value.toLocaleString("pt-BR")} ${param.unit})` });
        await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.suspend_auto', entityType: 'work_permit', entityId: id, data: { parameter: param.key, value: input.value } });
        return { ...m, suspended: true };
      }
      return { ...m, suspended: false };
    });
  }

  /** Assinatura de quem libera, com as checagens que só uma pessoa autorizada pode atestar. */
  private async releaseOrResume(auth: AuthContext, t: TenantContext, id: string, mode: 'release' | 'resume') {
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.release', true);
      const expected = mode === 'release' ? 'AWAITING_APPROVAL' : 'SUSPENDED';
      if (pt.status !== expected) throw bad('WRONG_STATUS', mode === 'release' ? 'A PT não está aguardando aprovação.' : 'A PT não está suspensa.');
      const type = await tx.selectFrom('pt_types').select(['segregate_creator_releaser', 'releaser_qualification_type_id']).where('id', '=', pt.pt_type_id).executeTakeFirstOrThrow();
      if (type.segregate_creator_releaser && pt.created_by === auth.userId) throw forbidden('Quem criou a PT não pode liberá-la.');
      const me = await this.me(tx, auth);
      if (type.releaser_qualification_type_id) {
        const quals = me.workerId
          ? await tx.selectFrom('worker_qualifications').select(['valid_from', 'valid_until', 'revoked_at'])
            .where('worker_id', '=', me.workerId).where('type_id', '=', type.releaser_qualification_type_id).execute()
          : [];
        const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);
        const ok = quals.some((q) => coversPeriod({ typeId: '', validFrom: d(q.valid_from)!, validUntil: d(q.valid_until), revoked: !!q.revoked_at }, new Date(), pt.ends_at));
        if (!ok) throw forbidden('Você não tem a designação formal válida exigida para liberar este tipo de PT.');
      }
      this.sig.requireFreshAuth(auth, { mfa: true });
      if (mode === 'resume') {
        // Retomada exige nova ciência de toda a equipe.
        await tx.updateTable('pt_team').set({ acknowledged_signature_id: null }).where('pt_id', '=', id).execute();
      }
      const f = await this.svc.loadFull(tx, id);
      const r = this.svc.check(f, mode);
      if (!r.ready) throw notReady(r);
      const signed = await this.sig.sign(tx, t.tenantId, auth, {
        documentType: 'work_permit', documentId: id, content: this.svc.snapshot(f), meaning: mode === 'release' ? 'RELEASE' : 'RESUME',
        signerName: me.name, context: { roles: t.assignments, workerId: me.workerId, qualificationTypeId: type.releaser_qualification_type_id },
      });
      const row = await this.setStatus(tx, id, pt.row_version, 'RELEASED', { released_by: auth.userId, released_at: new Date(), status_reason: null });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: mode === 'release' ? 'pt.release' : 'pt.resume', entityType: 'work_permit', entityId: id, data: { signatureId: signed.signatureId, hash: signed.hash } });
      return { ...row, signatureId: signed.signatureId, hash: signed.hash };
    });
  }

  @Post(':id/release')
  @HttpCode(200)
  @RequirePermission('pt.release')
  release(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.releaseOrResume(auth, t, id, 'release');
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('pt.release')
  resume(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.releaseOrResume(auth, t, id, 'resume');
  }

  /** Ciência dos riscos: cada integrante da equipe assina com a própria conta. */
  @Post(':id/acknowledge')
  @HttpCode(200)
  @RequirePermission('pt.read')
  acknowledge(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.read', true);
      if (pt.status !== 'RELEASED') throw bad('WRONG_STATUS', 'A ciência é registrada com a PT liberada.');
      const me = await this.me(tx, auth);
      const rows = me.workerId
        ? await tx.selectFrom('pt_team').select(['id', 'function', 'acknowledged_signature_id']).where('pt_id', '=', id).where('worker_id', '=', me.workerId).execute()
        : [];
      if (rows.length === 0) throw forbidden('Você não está na equipe desta PT.');
      const pending = rows.filter((r) => !r.acknowledged_signature_id);
      if (pending.length === 0) throw bad('ALREADY_ACKNOWLEDGED', 'Sua ciência já está registrada.');
      this.sig.requireFreshAuth(auth, { mfa: false });
      const f = await this.svc.loadFull(tx, id);
      const signed = await this.sig.sign(tx, t.tenantId, auth, {
        documentType: 'work_permit', documentId: id, content: this.svc.snapshot(f), meaning: 'ACKNOWLEDGE',
        signerName: me.name, context: { workerId: me.workerId, functions: pending.map((p) => p.function) },
      });
      await tx.updateTable('pt_team').set({ acknowledged_signature_id: signed.signatureId }).where('id', 'in', pending.map((p) => p.id)).execute();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.acknowledge', entityType: 'work_permit', entityId: id, data: { signatureId: signed.signatureId } });
      return { signatureId: signed.signatureId, hash: signed.hash };
    });
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('pt.field')
  start(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.field', true);
      if (pt.status !== 'RELEASED') throw bad('WRONG_STATUS', 'A PT não está liberada.');
      const v = this.svc.validity(pt);
      if (!v.valid) throw bad('OUT_OF_PERIOD', v.reason!);
      const f = await this.svc.loadFull(tx, id);
      const missing = f.team.filter((m) => !m.acknowledged_signature_id).map((m) => m.full_name);
      if (missing.length) throw bad('ACK_MISSING', `Falta a ciência de: ${[...new Set(missing)].join(', ')}.`);
      const r = this.svc.check(f, 'release');
      if (!r.ready) throw notReady(r);
      const row = await this.setStatus(tx, id, pt.row_version, 'IN_EXECUTION');
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.start', entityType: 'work_permit', entityId: id });
      return row;
    });
  }

  /**
   * Suspensão: qualquer pessoa com atuação em campo na unidade ou da equipe.
   * Não exige login recente: parar a atividade nunca pode ter atrito.
   */
  @Post(':id/suspend')
  @AllowWhenRestricted()
  @HttpCode(200)
  @RequirePermission('pt.read')
  suspend(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(reason, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.read', true);
      const me = await this.me(tx, auth);
      const inTeam = me.workerId ? !!(await tx.selectFrom('pt_team').select('id').where('pt_id', '=', id).where('worker_id', '=', me.workerId).executeTakeFirst()) : false;
      if (!inTeam && !canOnUnit(t.assignments, 'pt.field', pt.unit_id)) throw forbidden();
      if (pt.status !== 'RELEASED' && pt.status !== 'IN_EXECUTION') throw bad('WRONG_STATUS', 'Só PT liberada ou em execução pode ser suspensa.');
      const f = await this.svc.loadFull(tx, id);
      const signed = await this.sig.sign(tx, t.tenantId, auth, {
        documentType: 'work_permit', documentId: id, content: this.svc.snapshot(f), meaning: 'SUSPEND', signerName: me.name, context: { reason: input.reason },
      });
      const row = await this.setStatus(tx, id, pt.row_version, 'SUSPENDED', { suspended_at: new Date(), status_reason: input.reason });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.suspend', entityType: 'work_permit', entityId: id, data: { ...input, signatureId: signed.signatureId } });
      return row;
    });
  }

  @Post(':id/entries')
  @AllowWhenRestricted()
  @RequirePermission('pt.field')
  enter(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(entry, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.field');
      const type = await tx.selectFrom('pt_types').select('requires_entry_log').where('id', '=', pt.pt_type_id).executeTakeFirstOrThrow();
      if (!type.requires_entry_log) throw bad('ENTRY_LOG_DISABLED', 'Este tipo de PT não usa controle de entradas.');
      const v = this.svc.validity(pt);
      if (pt.status !== 'IN_EXECUTION' || !v.valid) throw bad('ENTRY_NOT_ALLOWED', `Entrada não autorizada: ${v.reason ?? 'a PT não está em execução.'}`);
      const e = await tx.insertInto('pt_entries').values({ tenant_id: t.tenantId, pt_id: id, worker_id: input.workerId, entered_by: auth.userId })
        .returning(['id', 'entered_at']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.entry', entityType: 'work_permit', entityId: id, data: input });
      return e;
    });
  }

  /** Registro de saída: aceito em QUALQUER situação da PT. */
  @Post(':id/entries/:entryId/exit')
  @AllowWhenRestricted()
  @HttpCode(200)
  @RequirePermission('pt.read')
  exit(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('entryId') entryId: string) {
    if (!uuid.safeParse(entryId).success) throw notFound('Entrada');
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'pt.read');
      const r = await tx.updateTable('pt_entries').set({ exited_at: new Date(), exited_by: auth.userId })
        .where('id', '=', entryId).where('pt_id', '=', id).where('exited_at', 'is', null).returning(['id', 'exited_at']).executeTakeFirst();
      if (!r) throw notFound('Entrada em aberto');
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.exit', entityType: 'work_permit', entityId: id, data: { entryId } });
      return r;
    });
  }

  @Post(':id/close')
  @AllowWhenRestricted()
  @HttpCode(200)
  @RequirePermission('pt.field')
  close(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(close, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.field', true);
      if (!['IN_EXECUTION', 'SUSPENDED', 'EXPIRED'].includes(pt.status)) throw bad('WRONG_STATUS', 'Só PT em execução, suspensa ou expirada pode ser encerrada.');
      const me = await this.me(tx, auth);
      const responsible = me.workerId ? !!(await tx.selectFrom('pt_team').select('id').where('pt_id', '=', id).where('worker_id', '=', me.workerId).where('function', '=', 'RESPONSIBLE').executeTakeFirst()) : false;
      if (!responsible && !canOnUnit(t.assignments, 'pt.release', pt.unit_id)) throw forbidden('O encerramento é feito pelo responsável da execução ou por quem libera PT.');
      await this.noOpenEntries(tx, id);
      this.sig.requireFreshAuth(auth, { mfa: false });
      const f = await this.svc.loadFull(tx, id);
      const signed = await this.sig.sign(tx, t.tenantId, auth, {
        documentType: 'work_permit', documentId: id, content: { ...this.svc.snapshot(f), closing: input }, meaning: 'CLOSE', signerName: me.name, context: input,
      });
      const row = await this.setStatus(tx, id, pt.row_version, 'CLOSED', { closed_by: auth.userId, closed_at: new Date(), closing_notes: input.notes ?? null });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.close', entityType: 'work_permit', entityId: id, data: { ...input, signatureId: signed.signatureId } });
      return row;
    });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('pt.write')
  cancel(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(reason, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.write', true);
      if (pt.created_by !== auth.userId && !canOnUnit(t.assignments, 'pt.release', pt.unit_id)) throw forbidden('Só quem criou ou quem libera PT pode cancelar.');
      if (!['DRAFT', 'IN_ANALYSIS', 'AWAITING_CORRECTION', 'AWAITING_APPROVAL', 'RELEASED', 'SUSPENDED'].includes(pt.status)) {
        throw bad('WRONG_STATUS', pt.status === 'IN_EXECUTION' ? 'Suspenda a PT em execução antes de cancelar.' : 'Esta PT não pode ser cancelada.');
      }
      await this.noOpenEntries(tx, id);
      const row = await this.setStatus(tx, id, pt.row_version, 'CANCELLED', { status_reason: input.reason });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.cancel', entityType: 'work_permit', entityId: id, data: input });
      return row;
    });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('pt.read')
  reject(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(reason, body);
    return this.run(auth, t, async (tx) => {
      const pt = await this.scoped(tx, t, id, 'pt.read', true);
      const can = (pt.status === 'IN_ANALYSIS' && canOnUnit(t.assignments, 'pt.review', pt.unit_id))
        || (pt.status === 'AWAITING_APPROVAL' && canOnUnit(t.assignments, 'pt.release', pt.unit_id));
      if (!['IN_ANALYSIS', 'AWAITING_APPROVAL'].includes(pt.status)) throw bad('WRONG_STATUS', 'Só PT em análise ou aguardando aprovação pode ser rejeitada.');
      if (!can) throw forbidden();
      const row = await this.setStatus(tx, id, pt.row_version, 'REJECTED', { status_reason: input.reason });
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt.reject', entityType: 'work_permit', entityId: id, data: input });
      return row;
    });
  }
}
