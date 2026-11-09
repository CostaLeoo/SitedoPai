import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ANSWERS, audit, CONTROL_TYPES, CRITICALITIES, MISMATCH_EFFECTS, sql } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import { forbidden, notFound, requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const question = z.strictObject({
  text: z.string().trim().min(1, 'Escreva a pergunta').max(500),
  helpText: z.string().trim().max(1000).optional(),
  expectedAnswer: z.enum(ANSWERS),
  criticality: z.enum(CRITICALITIES),
  required: z.boolean(),
  allowNa: z.boolean(),
  justificationOn: z.array(z.enum(['YES', 'NO', 'NA', 'MISMATCH'])).max(4),
  photosRequired: z.number().int().min(0).max(5),
  photosMax: z.number().int().min(0).max(5),
  mismatchEffect: z.enum(MISMATCH_EFFECTS),
  normativeRef: z.string().trim().max(200).optional(),
}).superRefine((q, ctx) => {
  if (q.photosRequired > q.photosMax) ctx.addIssue({ code: 'custom', path: ['photosRequired'], message: 'Fotos obrigatórias acima do máximo' });
  if (q.expectedAnswer === 'NA' && !q.allowNa) ctx.addIssue({ code: 'custom', path: ['allowNa'], message: 'Resposta esperada N/A exige permitir N/A' });
  if (q.criticality === 'CRITICAL' && q.mismatchEffect !== 'BLOCK') {
    ctx.addIssue({ code: 'custom', path: ['mismatchEffect'], message: 'Pergunta crítica precisa bloquear o avanço' });
  }
});

const createTemplate = z.strictObject({
  name: z.string().trim().min(1).max(120),
  serviceType: z.string().trim().min(1).max(80),
});
const putQuestions = z.strictObject({ questions: z.array(question).min(1, 'Inclua ao menos uma pergunta').max(200) });
const review = z.strictObject({
  approve: z.boolean(),
  note: z.string().trim().max(2000).optional(),
  professionalValidation: z.strictObject({
    name: z.string().trim().min(1).max(120),
    registry: z.string().trim().min(1, 'Informe o registro profissional').max(60),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
}).refine((r) => !r.approve || r.professionalValidation, { path: ['professionalValidation'], message: 'Para publicar, identifique o profissional que validou o modelo' })
  .refine((r) => r.approve || (r.note && r.note.length > 0), { path: ['note'], message: 'Explique o motivo da devolução' });

const libraryEntry = z.strictObject({
  hazard: z.string().trim().min(1).max(200),
  consequence: z.string().trim().min(1).max(300),
  suggestedControls: z.array(z.strictObject({ description: z.string().trim().min(1).max(300), type: z.enum(CONTROL_TYPES) })).max(20),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

@Controller()
export class TemplatesController {
  constructor(private readonly db: DbService) {}

  private ctx(auth: AuthContext, t: TenantContext) {
    return { tenantId: t.tenantId, userId: auth.userId };
  }

  @Get('apr-templates')
  @RequirePermission('config.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    return this.db.run(this.ctx(auth, t), async (tx) => {
      const templates = await tx.selectFrom('apr_templates').select(['id', 'name', 'service_type']).orderBy('name').execute();
      const versions = await tx.selectFrom('apr_template_versions')
        .select(['id', 'template_id', 'version', 'status', 'published_at', 'professional_validation']).orderBy('version').execute();
      return templates.map((tp) => ({ ...tp, versions: versions.filter((v) => v.template_id === tp.id) }));
    });
  }

  @Post('apr-templates')
  @RequirePermission('template.write')
  create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    requireTenantWide(t, 'template.write');
    const input = parse(createTemplate, body);
    return this.db.run(this.ctx(auth, t), async (tx) => {
      const tp = await tx.insertInto('apr_templates').values({ tenant_id: t.tenantId, name: input.name, service_type: input.serviceType, created_by: auth.userId })
        .returning('id').executeTakeFirstOrThrow();
      const v = await tx.insertInto('apr_template_versions').values({ tenant_id: t.tenantId, template_id: tp.id, version: 1, author_id: auth.userId })
        .returning(['id', 'version', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'template.create', entityType: 'apr_template', entityId: tp.id, data: input });
      return { id: tp.id, version: v };
    });
  }

  /** Nova versão em rascunho, copiando as perguntas da versão mais recente. */
  @Post('apr-templates/:id/versions')
  @RequirePermission('template.write')
  async newVersion(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    requireTenantWide(t, 'template.write');
    if (!uuid.safeParse(id).success) throw notFound('Modelo');
    const r = await this.db.run(this.ctx(auth, t), async (tx) => {
      const last = await tx.selectFrom('apr_template_versions').select(['id', 'version', 'status'])
        .where('template_id', '=', id).orderBy('version', 'desc').limit(1).forUpdate().executeTakeFirst();
      if (!last) return null;
      if (last.status === 'DRAFT' || last.status === 'IN_REVIEW') {
        throw new BadRequestException({ code: 'DRAFT_EXISTS', message: 'Já existe uma versão em rascunho ou em revisão.' });
      }
      const v = await tx.insertInto('apr_template_versions').values({ tenant_id: t.tenantId, template_id: id, version: last.version + 1, author_id: auth.userId })
        .returning(['id', 'version', 'status']).executeTakeFirstOrThrow();
      await sql`INSERT INTO apr_template_questions (tenant_id, template_version_id, position, text, help_text, expected_answer, criticality,
                  required, allow_na, justification_on, photos_required, photos_max, mismatch_effect, normative_ref)
                SELECT tenant_id, ${v.id}, position, text, help_text, expected_answer, criticality, required, allow_na,
                       justification_on, photos_required, photos_max, mismatch_effect, normative_ref
                  FROM apr_template_questions WHERE template_version_id = ${last.id}`.execute(tx);
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'template.new_version', entityType: 'apr_template', entityId: id, data: { version: v.version } });
      return v;
    });
    if (!r) throw notFound('Modelo');
    return r;
  }

  @Get('apr-template-versions/:id')
  @RequirePermission('config.read')
  async getVersion(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Versão do modelo');
    const r = await this.db.run(this.ctx(auth, t), async (tx) => {
      const v = await tx.selectFrom('apr_template_versions').innerJoin('apr_templates', 'apr_templates.id', 'apr_template_versions.template_id')
        .select(['apr_template_versions.id', 'apr_template_versions.version', 'apr_template_versions.status', 'apr_template_versions.author_id',
          'apr_template_versions.reviewed_by', 'apr_template_versions.review_note', 'apr_template_versions.professional_validation',
          'apr_templates.id as template_id', 'apr_templates.name', 'apr_templates.service_type'])
        .where('apr_template_versions.id', '=', id).executeTakeFirst();
      if (!v) return null;
      const questions = await tx.selectFrom('apr_template_questions').selectAll().where('template_version_id', '=', id).orderBy('position').execute();
      return { ...v, questions: questions.map(({ tenant_id: _t, template_version_id: _v, ...q }) => q) };
    });
    if (!r) throw notFound('Versão do modelo');
    return r;
  }

  /** Substitui as perguntas de uma versão em rascunho (a ordem do envio vira a posição). */
  @Put('apr-template-versions/:id/questions')
  @RequirePermission('template.write')
  async putQuestions(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'template.write');
    if (!uuid.safeParse(id).success) throw notFound('Versão do modelo');
    const input = parse(putQuestions, body);
    const ok = await this.db.run(this.ctx(auth, t), async (tx) => {
      const v = await tx.selectFrom('apr_template_versions').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!v) return false;
      if (v.status !== 'DRAFT') throw new BadRequestException({ code: 'NOT_DRAFT', message: 'Só versões em rascunho podem ser alteradas.' });
      await tx.deleteFrom('apr_template_questions').where('template_version_id', '=', id).execute();
      await tx.insertInto('apr_template_questions').values(input.questions.map((q, i) => ({
        tenant_id: t.tenantId, template_version_id: id, position: i + 1, text: q.text, help_text: q.helpText ?? null,
        expected_answer: q.expectedAnswer, criticality: q.criticality, required: q.required, allow_na: q.allowNa,
        justification_on: q.justificationOn, photos_required: q.photosRequired, photos_max: q.photosMax,
        mismatch_effect: q.mismatchEffect, normative_ref: q.normativeRef ?? null,
      }))).execute();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'template.questions', entityType: 'apr_template_version', entityId: id, data: { count: input.questions.length } });
      return true;
    });
    if (!ok) throw notFound('Versão do modelo');
    return { questions: input.questions.length };
  }

  @Post('apr-template-versions/:id/submit')
  @RequirePermission('template.write')
  async submit(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    requireTenantWide(t, 'template.write');
    if (!uuid.safeParse(id).success) throw notFound('Versão do modelo');
    const r = await this.db.run(this.ctx(auth, t), async (tx) => {
      const count = await tx.selectFrom('apr_template_questions').select((eb) => eb.fn.countAll().as('n')).where('template_version_id', '=', id).executeTakeFirst();
      if (Number(count?.n ?? 0) === 0) throw new BadRequestException({ code: 'NO_QUESTIONS', message: 'Inclua as perguntas antes de enviar para revisão.' });
      const row = await tx.updateTable('apr_template_versions').set({ status: 'IN_REVIEW', submitted_at: new Date() })
        .where('id', '=', id).where('status', '=', 'DRAFT').returning(['id', 'status']).executeTakeFirst();
      if (row) await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'template.submit', entityType: 'apr_template_version', entityId: id });
      return row;
    });
    if (!r) throw notFound('Versão em rascunho');
    return r;
  }

  /**
   * Revisão técnica: publica (com identificação do profissional que validou) ou
   * devolve para rascunho. Quem revisa não pode ser quem escreveu a versão.
   */
  @Post('apr-template-versions/:id/review')
  @RequirePermission('template.review')
  async review(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'template.review');
    if (!uuid.safeParse(id).success) throw notFound('Versão do modelo');
    const input = parse(review, body);
    const r = await this.db.run(this.ctx(auth, t), async (tx) => {
      const v = await tx.selectFrom('apr_template_versions').select(['status', 'author_id', 'template_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!v || v.status !== 'IN_REVIEW') return null;
      if (v.author_id === auth.userId) throw forbidden('A revisão precisa ser feita por outra pessoa, não por quem escreveu o modelo.');
      if (input.approve) {
        // Ao publicar, a versão publicada anterior é aposentada: só uma vale por vez.
        await tx.updateTable('apr_template_versions').set({ status: 'RETIRED' })
          .where('template_id', '=', v.template_id).where('status', '=', 'PUBLISHED').execute();
      }
      const row = await tx.updateTable('apr_template_versions').set({
        status: input.approve ? 'PUBLISHED' : 'DRAFT', reviewed_by: auth.userId, reviewed_at: new Date(), review_note: input.note ?? null,
        professional_validation: input.approve ? JSON.stringify(input.professionalValidation) : null,
        published_at: input.approve ? new Date() : null,
      }).where('id', '=', id).returning(['id', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: input.approve ? 'template.publish' : 'template.return', entityType: 'apr_template_version', entityId: id, data: input });
      return row;
    });
    if (!r) throw notFound('Versão em revisão');
    return r;
  }

  @Get('hazard-library')
  @RequirePermission('config.read')
  library(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Query('q') q?: string) {
    const term = typeof q === 'string' ? q.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&') : '';
    return this.db.run(this.ctx(auth, t), (tx) => {
      let query = tx.selectFrom('hazard_library').select(['id', 'hazard', 'consequence', 'suggested_controls', 'tags'])
        .where('active', '=', true).orderBy('hazard').limit(100);
      if (term) query = query.where((eb) => eb.or([eb('hazard', 'ilike', `%${term}%`), eb('consequence', 'ilike', `%${term}%`)]));
      return query.execute();
    });
  }

  @Post('hazard-library')
  @RequirePermission('hazard_library.write')
  addLibrary(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    requireTenantWide(t, 'hazard_library.write');
    const input = parse(libraryEntry, body);
    return this.db.run(this.ctx(auth, t), async (tx) => {
      const row = await tx.insertInto('hazard_library').values({
        tenant_id: t.tenantId, hazard: input.hazard, consequence: input.consequence,
        suggested_controls: JSON.stringify(input.suggestedControls), tags: input.tags,
      }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'hazard_library.create', entityType: 'hazard_library', entityId: row.id, data: input });
      return row;
    });
  }
}
