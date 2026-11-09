import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { audit, TEAM_FUNCTIONS, Tx } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import { forbidden, notFound, requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const gasParam = z.strictObject({
  key: z.string().regex(/^[a-z0-9_]{1,30}$/, 'Use letras minúsculas, números e _'),
  label: z.string().trim().min(1).max(60),
  unit: z.string().trim().min(1).max(20),
  min: z.number().optional(),
  max: z.number().optional(),
}).refine((p) => p.min !== undefined || p.max !== undefined, 'Defina ao menos um limite')
  .refine((p) => p.min === undefined || p.max === undefined || p.min < p.max, 'Mínimo deve ser menor que o máximo');

const ptType = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  checklistTemplateVersionId: z.string().uuid(),
  maxValidityMinutes: z.number().int().min(15).max(10080),
  requiresGasMonitoring: z.boolean(),
  gasParameters: z.array(gasParam).max(10),
  gasMaxAgeMinutes: z.number().int().min(1).max(1440).nullable(),
  requiresEntryLog: z.boolean(),
  releaserQualificationTypeId: z.string().uuid().nullable(),
  segregateCreatorReleaser: z.boolean(),
  requirements: z.array(z.strictObject({
    function: z.enum(TEAM_FUNCTIONS),
    minCount: z.number().int().min(0).max(50),
    qualificationTypeIds: z.array(z.string().uuid()).max(10),
  })).max(5),
}).superRefine((v, ctx) => {
  if (v.requiresGasMonitoring && (v.gasParameters.length === 0 || v.gasMaxAgeMinutes === null)) {
    ctx.addIssue({ code: 'custom', path: ['gasParameters'], message: 'Com monitoramento, defina os parâmetros e a idade máxima da medição' });
  }
  if (new Set(v.gasParameters.map((p) => p.key)).size !== v.gasParameters.length) ctx.addIssue({ code: 'custom', path: ['gasParameters'], message: 'Parâmetros repetidos' });
  if (new Set(v.requirements.map((r) => r.function)).size !== v.requirements.length) ctx.addIssue({ code: 'custom', path: ['requirements'], message: 'Função repetida' });
});

const review = z.strictObject({
  professionalValidation: z.strictObject({
    name: z.string().trim().min(1).max(120),
    registry: z.string().trim().min(1, 'Informe o registro profissional').max(60),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

/**
 * Tipos de PT: o SST define validade máxima, parâmetros atmosféricos e limites,
 * funções obrigatórias, qualificações por função e a designação de quem libera.
 * Publicação exige outro SST e a identificação do profissional que validou.
 */
@Controller('pt-types')
export class PtTypesController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('pt.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const types = await tx.selectFrom('pt_types').selectAll().orderBy('name').orderBy('version').execute();
      const reqs = await tx.selectFrom('pt_type_requirements').select(['pt_type_id', 'function', 'min_count', 'qualification_type_ids']).execute();
      return types.map(({ tenant_id: _t, ...ty }) => ({ ...ty, requirements: reqs.filter((r) => r.pt_type_id === ty.id) }));
    });
  }

  private async validateRefs(tx: Tx, input: z.infer<typeof ptType>) {
    const v = await tx.selectFrom('apr_template_versions').select('status').where('id', '=', input.checklistTemplateVersionId).executeTakeFirst();
    if (!v || v.status !== 'PUBLISHED') throw new BadRequestException({ code: 'INVALID_REFERENCE', message: 'O checklist precisa ser um modelo publicado.' });
    const withPhotos = await tx.selectFrom('apr_template_questions').select('id')
      .where('template_version_id', '=', input.checklistTemplateVersionId).where('photos_required', '>', 0).executeTakeFirst();
    if (withPhotos) {
      throw new BadRequestException({ code: 'CHECKLIST_PHOTOS_UNSUPPORTED', message: 'Fotos obrigatórias no checklist da PT ainda não são suportadas. Use um modelo sem fotos obrigatórias.' });
    }
    const ids = [...new Set([...input.requirements.flatMap((r) => r.qualificationTypeIds), ...(input.releaserQualificationTypeId ? [input.releaserQualificationTypeId] : [])])];
    if (ids.length) {
      const found = await tx.selectFrom('qualification_types').select('id').where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new BadRequestException({ code: 'INVALID_REFERENCE', message: 'Há tipo de qualificação inexistente.' });
    }
  }

  private values(input: z.infer<typeof ptType>) {
    return {
      description: input.description ?? null, checklist_template_version_id: input.checklistTemplateVersionId,
      max_validity_minutes: input.maxValidityMinutes, requires_gas_monitoring: input.requiresGasMonitoring,
      gas_parameters: JSON.stringify(input.gasParameters), gas_max_age_minutes: input.gasMaxAgeMinutes,
      requires_entry_log: input.requiresEntryLog, releaser_qualification_type_id: input.releaserQualificationTypeId,
      segregate_creator_releaser: input.segregateCreatorReleaser,
    };
  }

  private async putRequirements(tx: Tx, tenantId: string, id: string, input: z.infer<typeof ptType>) {
    await tx.deleteFrom('pt_type_requirements').where('pt_type_id', '=', id).execute();
    if (input.requirements.length) {
      await tx.insertInto('pt_type_requirements').values(input.requirements.map((r) => ({
        tenant_id: tenantId, pt_type_id: id, function: r.function, min_count: r.minCount, qualification_type_ids: r.qualificationTypeIds,
      }))).execute();
    }
  }

  @Post()
  @RequirePermission('pt_type.write')
  create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    requireTenantWide(t, 'pt_type.write');
    const input = parse(ptType, body);
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await this.validateRefs(tx, input);
      const last = await tx.selectFrom('pt_types').select((eb) => eb.fn.max('version').as('v')).where('name', '=', input.name).executeTakeFirst();
      const row = await tx.insertInto('pt_types').values({
        tenant_id: t.tenantId, name: input.name, version: Number(last?.v ?? 0) + 1, author_id: auth.userId, ...this.values(input),
      }).returning(['id', 'version', 'status']).executeTakeFirstOrThrow();
      await this.putRequirements(tx, t.tenantId, row.id, input);
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt_type.create', entityType: 'pt_type', entityId: row.id, data: input });
      return row;
    });
  }

  @Put(':id')
  @RequirePermission('pt_type.write')
  async update(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'pt_type.write');
    if (!uuid.safeParse(id).success) throw notFound('Tipo de PT');
    const input = parse(ptType, body);
    const r = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const cur = await tx.selectFrom('pt_types').select(['status', 'name']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) return null;
      if (cur.status !== 'DRAFT') throw new BadRequestException({ code: 'NOT_DRAFT', message: 'Só tipos em rascunho podem ser alterados; crie uma nova versão.' });
      if (cur.name !== input.name) throw new BadRequestException({ code: 'NAME_CHANGE', message: 'O nome identifica as versões e não pode mudar.' });
      await this.validateRefs(tx, input);
      await tx.updateTable('pt_types').set(this.values(input)).where('id', '=', id).execute();
      await this.putRequirements(tx, t.tenantId, id, input);
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt_type.update', entityType: 'pt_type', entityId: id, data: input });
      return { id };
    });
    if (!r) throw notFound('Tipo de PT');
    return r;
  }

  /** Publica o tipo; revisor ≠ autor, com identificação do profissional que validou. */
  @Post(':id/publish')
  @RequirePermission('pt_type.review')
  async publish(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'pt_type.review');
    if (!uuid.safeParse(id).success) throw notFound('Tipo de PT');
    const input = parse(review, body);
    const r = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const cur = await tx.selectFrom('pt_types').select(['status', 'author_id', 'name']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur || cur.status !== 'DRAFT') return null;
      if (cur.author_id === auth.userId) throw forbidden('A publicação precisa ser feita por outra pessoa, não por quem configurou o tipo.');
      await tx.updateTable('pt_types').set({ status: 'RETIRED' }).where('name', '=', cur.name).where('status', '=', 'PUBLISHED').execute();
      const row = await tx.updateTable('pt_types').set({
        status: 'PUBLISHED', reviewed_by: auth.userId, published_at: new Date(), professional_validation: JSON.stringify(input.professionalValidation),
      }).where('id', '=', id).returning(['id', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'pt_type.publish', entityType: 'pt_type', entityId: id, data: input });
      return row;
    });
    if (!r) throw notFound('Tipo de PT em rascunho');
    return r;
  }
}
