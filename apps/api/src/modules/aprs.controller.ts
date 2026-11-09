import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ANSWERS, audit, CONTROL_TYPES, sql, Tx } from '@sitedopai/db';
import { unitScope } from '../authz/permissions';
import { AprService, staleVersion } from '../apr/apr.service';
import { isMismatch } from '../apr/rules';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import { forbidden, notFound, requireUnit } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const text = (max: number) => z.string().trim().max(max);
const teamMember = z.strictObject({
  name: z.string().trim().min(1).max(120),
  role: text(80).optional(),
  membershipId: z.string().uuid().optional(),
  contractorId: z.string().uuid().optional(),
});
const header = {
  sectorId: z.string().uuid().nullable().optional(),
  location: text(300).optional(),
  activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD').optional(),
  serviceDescription: text(4000).optional(),
  responsibleName: text(120).optional(),
  team: z.array(teamMember).max(100).optional(),
  equipment: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  contractorIds: z.array(z.string().uuid()).max(20).optional(),
};
const createApr = z.strictObject({
  templateVersionId: z.string().uuid(),
  riskMatrixId: z.string().uuid(),
  unitId: z.string().uuid(),
  ...header,
  activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD'),
});
const patchApr = z.strictObject({ rowVersion: z.number().int().positive(), ...header });
const putAnswer = z.strictObject({
  answer: z.enum(ANSWERS),
  justification: text(2000).nullable().optional(),
  correctiveAction: text(2000).nullable().optional(),
  /** Versão que o cliente tinha; omitir apenas na primeira resposta. */
  version: z.number().int().positive().optional(),
});
const reassess = z.strictObject({ answer: z.enum(ANSWERS), version: z.number().int().positive() });
const level = z.number().int().min(1).max(10).nullable();
const analysis = z.strictObject({
  analysisVersion: z.number().int().positive(),
  steps: z.array(z.strictObject({
    description: z.string().trim().min(1, 'Descreva a etapa').max(1000),
    hazards: z.array(z.strictObject({
      hazard: z.string().trim().min(1, 'Descreva o perigo').max(300),
      consequence: z.string().trim().min(1, 'Descreva a consequência').max(500),
      probability: level, severity: level, residualProbability: level, residualSeverity: level,
      libraryId: z.string().uuid().nullable().optional(),
      controls: z.array(z.strictObject({
        description: z.string().trim().min(1, 'Descreva a medida').max(500),
        type: z.enum(CONTROL_TYPES),
        responsibleName: text(120).default(''),
        verified: z.boolean().default(false),
      })).max(30),
    })).max(50),
  })).max(50),
});
const decision = z.strictObject({ note: z.string().trim().max(2000).optional() });
const requiredNote = z.strictObject({ note: z.string().trim().min(1, 'Explique o motivo').max(2000) });
const listQuery = z.object({
  status: z.enum(['DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED']).optional(),
  /** Paginação por cursor: data e id do último item da página anterior. */
  before: z.string().datetime({ offset: true }).optional(),
  beforeId: z.string().uuid().optional(),
});
export const PAGE_SIZE = 100;

const EDITABLE = new Set(['DRAFT', 'RETURNED']);
const notEditable = () => new BadRequestException({ code: 'APR_NOT_EDITABLE', message: 'A APR não está em edição.' });

@Controller('aprs')
export class AprsController {
  constructor(private readonly db: DbService, private readonly svc: AprService) {}

  private run<T>(auth: AuthContext, t: TenantContext, fn: (tx: Tx) => Promise<T>) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, fn);
  }

  /** Carrega a APR e confere o escopo da unidade; fora do escopo é "não encontrada". */
  private async scoped(tx: Tx, t: TenantContext, id: string, p: 'apr.read' | 'apr.write' | 'apr.approve', lock = false) {
    if (!uuid.safeParse(id).success) throw notFound('APR');
    let q = tx.selectFrom('aprs').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const apr = await q.executeTakeFirst();
    if (!apr) throw notFound('APR');
    try {
      requireUnit(t, 'apr.read', apr.unit_id);
    } catch {
      throw notFound('APR');
    }
    if (p !== 'apr.read') requireUnit(t, p, apr.unit_id);
    return apr;
  }

  @Get()
  @RequirePermission('apr.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Query() q: unknown) {
    const { status, before, beforeId } = parse(listQuery, q);
    const scope = unitScope(t.assignments, 'apr.read');
    return this.run(auth, t, (tx) => {
      let query = tx.selectFrom('aprs').select(['id', 'number', 'revision', 'status', 'unit_id', 'activity_date', 'location', 'service_description', 'updated_at'])
        .orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(PAGE_SIZE);
      if (status) query = query.where('status', '=', status);
      if (before && beforeId) query = query.where(sql<boolean>`(updated_at, id) < (${before}::timestamptz, ${beforeId}::uuid)`);
      if (!scope.all) query = scope.unitIds.length ? query.where('unit_id', 'in', scope.unitIds) : query.where(sql<boolean>`false`);
      return query.execute();
    });
  }

  @Post()
  @RequirePermission('apr.write')
  async create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    const input = parse(createApr, body);
    requireUnit(t, 'apr.write', input.unitId);
    return this.run(auth, t, async (tx) => {
      const num = await sql<{ n: string }>`SELECT next_apr_number(${Number(input.activityDate.slice(0, 4))}) AS n`.execute(tx);
      const apr = await tx.insertInto('aprs').values({
        tenant_id: t.tenantId, number: num.rows[0]!.n, template_version_id: input.templateVersionId, risk_matrix_id: input.riskMatrixId,
        unit_id: input.unitId, sector_id: input.sectorId ?? null, location: input.location ?? '', activity_date: input.activityDate,
        service_description: input.serviceDescription ?? '', responsible_name: input.responsibleName ?? '',
        team: JSON.stringify(input.team ?? []), equipment: JSON.stringify(input.equipment ?? []),
        contractor_ids: input.contractorIds ?? [], created_by: auth.userId,
      }).returning(['id', 'number', 'status', 'row_version']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.create', entityType: 'apr', entityId: apr.id, data: { number: apr.number } });
      return apr;
    });
  }

  @Get(':id')
  @RequirePermission('apr.read')
  get(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'apr.read');
      return this.svc.present(await this.svc.loadFull(tx, id));
    });
  }

  @Patch(':id')
  @RequirePermission('apr.write')
  update(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const { rowVersion, ...input } = parse(patchApr, body);
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write', true);
      if (!EDITABLE.has(apr.status)) throw notEditable();
      if (apr.row_version !== rowVersion) throw staleVersion('O cabeçalho da APR');
      const set: Record<string, unknown> = { row_version: apr.row_version + 1 };
      if (input.sectorId !== undefined) set.sector_id = input.sectorId;
      if (input.location !== undefined) set.location = input.location;
      if (input.activityDate !== undefined) set.activity_date = input.activityDate;
      if (input.serviceDescription !== undefined) set.service_description = input.serviceDescription;
      if (input.responsibleName !== undefined) set.responsible_name = input.responsibleName;
      if (input.team !== undefined) set.team = JSON.stringify(input.team);
      if (input.equipment !== undefined) set.equipment = JSON.stringify(input.equipment);
      if (input.contractorIds !== undefined) set.contractor_ids = input.contractorIds;
      const row = await tx.updateTable('aprs').set(set).where('id', '=', id).returning(['id', 'row_version']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.update', entityType: 'apr', entityId: id, data: input });
      return { id: row.id, rowVersion: row.row_version };
    });
  }

  /** Grava (ou altera) a resposta de uma pergunta. Mudar a resposta zera a nova avaliação. */
  @Put(':id/answers/:questionId')
  @RequirePermission('apr.write')
  answer(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('questionId') questionId: string, @Body() body: unknown) {
    const input = parse(putAnswer, body);
    if (!uuid.safeParse(questionId).success) throw notFound('Pergunta');
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write');
      if (!EDITABLE.has(apr.status)) throw notEditable();
      const q = await tx.selectFrom('apr_template_questions').select(['id', 'allow_na'])
        .where('id', '=', questionId).where('template_version_id', '=', apr.template_version_id).executeTakeFirst();
      if (!q) throw notFound('Pergunta');
      if (input.answer === 'NA' && !q.allow_na) {
        throw new BadRequestException({ code: 'NA_NOT_ALLOWED', message: 'N/A não é permitido nesta pergunta.' });
      }
      const current = await tx.selectFrom('apr_answers').selectAll().where('apr_id', '=', id).where('question_id', '=', questionId).forUpdate().executeTakeFirst();
      const values = {
        answer: input.answer, justification: input.justification ?? null, corrective_action: input.correctiveAction ?? null,
        answered_by: auth.userId, answered_at: new Date(),
      };
      let row;
      if (!current) {
        if (input.version !== undefined) throw staleVersion('A resposta');
        row = await tx.insertInto('apr_answers').values({ tenant_id: t.tenantId, apr_id: id, question_id: questionId, ...values })
          .returning(['version']).executeTakeFirstOrThrow();
      } else {
        if (input.version !== current.version) throw staleVersion('A resposta');
        const answerChanged = current.answer !== input.answer;
        row = await tx.updateTable('apr_answers').set({
          ...values, version: current.version + 1,
          ...(answerChanged || current.answered_by !== auth.userId ? { reassessed_answer: null, reassessed_by: null, reassessed_at: null } : {}),
        }).where('id', '=', current.id).returning(['version']).executeTakeFirstOrThrow();
      }
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.answer', entityType: 'apr', entityId: id, data: { questionId, ...input } });
      return { questionId, version: row.version };
    });
  }

  /** Nova avaliação após ação corretiva, por pessoa diferente de quem respondeu. */
  @Post(':id/answers/:questionId/reassess')
  @HttpCode(200)
  @RequirePermission('apr.write')
  reassess(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('questionId') questionId: string, @Body() body: unknown) {
    const input = parse(reassess, body);
    if (!uuid.safeParse(questionId).success) throw notFound('Pergunta');
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write');
      if (!EDITABLE.has(apr.status)) throw notEditable();
      const row = await tx.selectFrom('apr_answers').innerJoin('apr_template_questions', 'apr_template_questions.id', 'apr_answers.question_id')
        .select(['apr_answers.id', 'apr_answers.answer', 'apr_answers.answered_by', 'apr_answers.corrective_action', 'apr_answers.version',
          'apr_template_questions.expected_answer', 'apr_template_questions.allow_na', 'apr_template_questions.mismatch_effect'])
        .where('apr_answers.apr_id', '=', id).where('apr_answers.question_id', '=', questionId).forUpdate().executeTakeFirst();
      if (!row) throw notFound('Resposta');
      if (row.version !== input.version) throw staleVersion('A resposta');
      if (row.mismatch_effect !== 'BLOCK' || !isMismatch({ expectedAnswer: row.expected_answer, allowNa: row.allow_na }, row.answer)) {
        throw new BadRequestException({ code: 'REASSESS_NOT_NEEDED', message: 'Esta resposta não exige nova avaliação.' });
      }
      if (!row.corrective_action?.trim()) {
        throw new BadRequestException({ code: 'CORRECTIVE_ACTION_REQUIRED', message: 'Registre a ação corretiva antes da nova avaliação.' });
      }
      if (row.answered_by === auth.userId) throw forbidden('A nova avaliação precisa ser feita por outra pessoa.');
      const updated = await tx.updateTable('apr_answers').set({
        reassessed_answer: input.answer, reassessed_by: auth.userId, reassessed_at: new Date(), version: row.version + 1,
      }).where('id', '=', row.id).returning(['version']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.reassess', entityType: 'apr', entityId: id, data: { questionId, answer: input.answer } });
      return { questionId, version: updated.version };
    });
  }

  /** Substitui a análise de riscos inteira (etapas, perigos, controles). */
  @Put(':id/analysis')
  @RequirePermission('apr.write')
  putAnalysis(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(analysis, body);
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write', true);
      if (!EDITABLE.has(apr.status)) throw notEditable();
      if (apr.analysis_version !== input.analysisVersion) throw staleVersion('A análise de riscos');
      const matrix = await this.svc.loadMatrix(tx, apr.risk_matrix_id);
      const pValues = new Set(matrix.probabilityLevels.map((l) => l.value));
      const sValues = new Set(matrix.severityLevels.map((l) => l.value));
      input.steps.forEach((s, si) => s.hazards.forEach((h, hi) => {
        for (const [field, v, allowed] of [['probability', h.probability, pValues], ['severity', h.severity, sValues],
          ['residualProbability', h.residualProbability, pValues], ['residualSeverity', h.residualSeverity, sValues]] as const) {
          if (v != null && !allowed.has(v)) {
            throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Revise os campos indicados.',
              fields: [{ field: `steps.${si}.hazards.${hi}.${field}`, message: 'Valor fora da matriz de risco da APR' }] });
          }
        }
      }));

      await tx.deleteFrom('apr_steps').where('apr_id', '=', id).execute();
      for (const [si, s] of input.steps.entries()) {
        const step = await tx.insertInto('apr_steps').values({ tenant_id: t.tenantId, apr_id: id, position: si + 1, description: s.description })
          .returning('id').executeTakeFirstOrThrow();
        for (const [hi, h] of s.hazards.entries()) {
          const hz = await tx.insertInto('apr_hazards').values({
            tenant_id: t.tenantId, step_id: step.id, position: hi + 1, hazard: h.hazard, consequence: h.consequence,
            probability: h.probability, severity: h.severity, residual_probability: h.residualProbability,
            residual_severity: h.residualSeverity, library_id: h.libraryId ?? null,
          }).returning('id').executeTakeFirstOrThrow();
          if (h.controls.length) {
            await tx.insertInto('apr_controls').values(h.controls.map((c, ci) => ({
              tenant_id: t.tenantId, hazard_id: hz.id, position: ci + 1, description: c.description,
              control_type: c.type, responsible_name: c.responsibleName, verified: c.verified,
            }))).execute();
          }
        }
      }
      const row = await tx.updateTable('aprs').set({ analysis_version: apr.analysis_version + 1 }).where('id', '=', id)
        .returning('analysis_version').executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.analysis', entityType: 'apr', entityId: id, data: { steps: input.steps } });
      return { analysisVersion: row.analysis_version };
    });
  }

  @Get(':id/check')
  @RequirePermission('apr.read')
  check(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'apr.read');
      return this.svc.check(tx, id);
    });
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('apr.write')
  submit(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write', true);
      if (!EDITABLE.has(apr.status)) throw notEditable();
      await this.svc.assertReady(tx, id);
      const row = await tx.updateTable('aprs').set({ status: 'IN_REVIEW', submitted_by: auth.userId, submitted_at: new Date(), row_version: apr.row_version + 1 })
        .where('id', '=', id).returning(['id', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.submit', entityType: 'apr', entityId: id });
      return row;
    });
  }

  /** Aprovação: sempre ato de uma pessoa, diferente de quem criou, no escopo da unidade. */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('apr.approve')
  approve(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(decision, body);
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.approve', true);
      if (apr.status !== 'IN_REVIEW') throw new BadRequestException({ code: 'NOT_IN_REVIEW', message: 'A APR não está aguardando revisão.' });
      if (apr.created_by === auth.userId) throw forbidden('Quem criou a APR não pode aprová-la.');
      await this.svc.assertReady(tx, id);
      const row = await tx.updateTable('aprs').set({ status: 'APPROVED', decided_by: auth.userId, decided_at: new Date(), decision_note: input.note ?? null, row_version: apr.row_version + 1 })
        .where('id', '=', id).returning(['id', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.approve', entityType: 'apr', entityId: id, data: input });
      return row;
    });
  }

  @Post(':id/return')
  @HttpCode(200)
  @RequirePermission('apr.approve')
  giveBack(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(requiredNote, body);
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.approve', true);
      if (apr.status !== 'IN_REVIEW') throw new BadRequestException({ code: 'NOT_IN_REVIEW', message: 'A APR não está aguardando revisão.' });
      const row = await tx.updateTable('aprs').set({ status: 'RETURNED', decided_by: auth.userId, decided_at: new Date(), decision_note: input.note, row_version: apr.row_version + 1 })
        .where('id', '=', id).returning(['id', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.return', entityType: 'apr', entityId: id, data: input });
      return row;
    });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('apr.write')
  cancel(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(requiredNote, body);
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write', true);
      if (apr.status === 'APPROVED' || apr.status === 'CANCELLED') {
        throw new BadRequestException({ code: 'APR_FINAL', message: 'APR finalizada não pode ser cancelada; crie uma revisão.' });
      }
      const row = await tx.updateTable('aprs').set({ status: 'CANCELLED', decision_note: input.note, row_version: apr.row_version + 1 })
        .where('id', '=', id).returning(['id', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.cancel', entityType: 'apr', entityId: id, data: input });
      return row;
    });
  }

  /**
   * Revisão de uma APR aprovada: nova APR com o mesmo número e revisão + 1,
   * copiando cabeçalho, respostas (sem a nova avaliação) e análise. Fotos não
   * são copiadas: a condição de campo precisa ser registrada de novo.
   */
  @Post(':id/revise')
  @RequirePermission('apr.write')
  revise(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      const apr = await this.scoped(tx, t, id, 'apr.write', true);
      if (apr.status !== 'APPROVED') throw new BadRequestException({ code: 'NOT_APPROVED', message: 'Só APR aprovada pode ser revisada.' });
      const exists = await tx.selectFrom('aprs').select('id').where('previous_revision_id', '=', id).executeTakeFirst();
      if (exists) throw new BadRequestException({ code: 'REVISION_EXISTS', message: 'Esta APR já tem uma revisão.', revisionId: exists.id });
      const next = await tx.insertInto('aprs').values({
        tenant_id: t.tenantId, number: apr.number, revision: apr.revision + 1, previous_revision_id: id,
        template_version_id: apr.template_version_id, risk_matrix_id: apr.risk_matrix_id, unit_id: apr.unit_id, sector_id: apr.sector_id,
        location: apr.location, activity_date: apr.activity_date.toISOString().slice(0, 10), service_description: apr.service_description,
        responsible_name: apr.responsible_name, team: JSON.stringify(apr.team), equipment: JSON.stringify(apr.equipment),
        contractor_ids: apr.contractor_ids, created_by: auth.userId,
      }).returning(['id', 'number', 'revision', 'status']).executeTakeFirstOrThrow();
      await sql`INSERT INTO apr_answers (tenant_id, apr_id, question_id, answer, justification, corrective_action, answered_by)
                SELECT tenant_id, ${next.id}, question_id, answer, justification, corrective_action, ${auth.userId}
                  FROM apr_answers WHERE apr_id = ${id}`.execute(tx);
      const full = await this.svc.loadFull(tx, id);
      for (const s of full.steps) {
        const ns = await tx.insertInto('apr_steps').values({ tenant_id: t.tenantId, apr_id: next.id, position: s.position, description: s.description })
          .returning('id').executeTakeFirstOrThrow();
        for (const h of full.hazards.filter((x) => x.step_id === s.id)) {
          const nh = await tx.insertInto('apr_hazards').values({
            tenant_id: t.tenantId, step_id: ns.id, position: h.position, hazard: h.hazard, consequence: h.consequence,
            probability: h.probability, severity: h.severity, residual_probability: h.residual_probability,
            residual_severity: h.residual_severity, library_id: h.library_id,
          }).returning('id').executeTakeFirstOrThrow();
          const cs = full.controls.filter((c) => c.hazard_id === h.id);
          if (cs.length) {
            await tx.insertInto('apr_controls').values(cs.map((c) => ({
              tenant_id: t.tenantId, hazard_id: nh.id, position: c.position, description: c.description,
              control_type: c.control_type, responsible_name: c.responsible_name, verified: false,
            }))).execute();
          }
        }
      }
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.revise', entityType: 'apr', entityId: next.id, data: { from: id, revision: next.revision } });
      return next;
    });
  }

  @Get(':id/history')
  @RequirePermission('apr.read')
  history(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.run(auth, t, async (tx) => {
      await this.scoped(tx, t, id, 'apr.read');
      const rows = await tx.selectFrom('audit_events').leftJoin('users', 'users.id', 'audit_events.actor_user_id')
        .select(['audit_events.seq', 'audit_events.occurred_at', 'audit_events.action', 'audit_events.data', 'users.display_name as actor'])
        .where('audit_events.entity_type', '=', 'apr').where('audit_events.entity_id', '=', id).orderBy('audit_events.seq').execute();
      return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
    });
  }
}
