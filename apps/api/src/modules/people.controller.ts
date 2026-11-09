import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { audit, Tx } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import { notFound, requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');
const worker = z.strictObject({
  fullName: z.string().trim().min(1, 'Informe o nome').max(160),
  registration: z.string().trim().max(60).optional(),
  contractorId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});
const patchWorker = z.strictObject({ active: z.boolean().optional(), userId: z.string().uuid().nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nada para alterar');
const qualType = z.strictObject({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['TRAINING', 'DESIGNATION', 'FITNESS', 'OTHER']),
  normativeRef: z.string().trim().max(120).optional(),
});
const qualification = z.strictObject({
  typeId: z.string().uuid(),
  validFrom: date,
  validUntil: date.nullable(),
  evidence: z.string().trim().max(500).optional(),
}).refine((q) => q.validUntil === null || q.validUntil >= q.validFrom, { path: ['validUntil'], message: 'Validade anterior ao início' });
const revoke = z.strictObject({ reason: z.string().trim().min(1, 'Explique o motivo').max(500) });

/**
 * Trabalhadores (próprios e de terceiros) e suas qualificações: treinamentos,
 * designações formais e aptidão. Aptidão guarda só "apto" e a validade, sem
 * dados clínicos (LGPD: dado de saúde é sensível).
 */
@Controller()
export class PeopleController {
  constructor(private readonly db: DbService) {}

  private run<T>(auth: AuthContext, t: TenantContext, fn: (tx: Tx) => Promise<T>) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, fn);
  }

  @Get('workers')
  @RequirePermission('people.read')
  workers(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    return this.run(auth, t, (tx) => tx.selectFrom('workers').select(['id', 'full_name', 'registration', 'contractor_id', 'user_id', 'active']).orderBy('full_name').execute());
  }

  @Post('workers')
  @RequirePermission('people.write')
  createWorker(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    requireTenantWide(t, 'people.write');
    const input = parse(worker, body);
    return this.run(auth, t, async (tx) => {
      const w = await tx.insertInto('workers').values({
        tenant_id: t.tenantId, full_name: input.fullName, registration: input.registration ?? null,
        contractor_id: input.contractorId ?? null, user_id: input.userId ?? null,
      }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'worker.create', entityType: 'worker', entityId: w.id, data: input });
      return w;
    });
  }

  @Patch('workers/:id')
  @RequirePermission('people.write')
  async patchWorker(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'people.write');
    if (!uuid.safeParse(id).success) throw notFound('Trabalhador');
    const input = parse(patchWorker, body);
    const r = await this.run(auth, t, async (tx) => {
      const set: Record<string, unknown> = {};
      if (input.active !== undefined) set.active = input.active;
      if (input.userId !== undefined) set.user_id = input.userId;
      const row = await tx.updateTable('workers').set(set).where('id', '=', id).returning('id').executeTakeFirst();
      if (row) await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'worker.update', entityType: 'worker', entityId: id, data: input });
      return row;
    });
    if (!r) throw notFound('Trabalhador');
    return r;
  }

  @Get('qualification-types')
  @RequirePermission('people.read')
  types(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    return this.run(auth, t, (tx) => tx.selectFrom('qualification_types').select(['id', 'name', 'kind', 'normative_ref', 'active']).orderBy('name').execute());
  }

  @Post('qualification-types')
  @RequirePermission('people.write')
  createType(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    requireTenantWide(t, 'people.write');
    const input = parse(qualType, body);
    return this.run(auth, t, async (tx) => {
      const r = await tx.insertInto('qualification_types').values({ tenant_id: t.tenantId, name: input.name, kind: input.kind, normative_ref: input.normativeRef ?? null })
        .returning('id').executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'qualification_type.create', entityType: 'qualification_type', entityId: r.id, data: input });
      return r;
    });
  }

  @Get('workers/:id/qualifications')
  @RequirePermission('people.read')
  async qualifications(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Trabalhador');
    return this.run(auth, t, async (tx) => {
      if (!(await tx.selectFrom('workers').select('id').where('id', '=', id).executeTakeFirst())) throw notFound('Trabalhador');
      return tx.selectFrom('worker_qualifications').innerJoin('qualification_types', 'qualification_types.id', 'worker_qualifications.type_id')
        .select(['worker_qualifications.id', 'worker_qualifications.type_id', 'qualification_types.name', 'qualification_types.kind',
          'worker_qualifications.valid_from', 'worker_qualifications.valid_until', 'worker_qualifications.evidence',
          'worker_qualifications.revoked_at', 'worker_qualifications.revoke_reason'])
        .where('worker_qualifications.worker_id', '=', id).orderBy('worker_qualifications.valid_from', 'desc').execute();
    });
  }

  @Post('workers/:id/qualifications')
  @RequirePermission('people.write')
  async addQualification(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'people.write');
    if (!uuid.safeParse(id).success) throw notFound('Trabalhador');
    const input = parse(qualification, body);
    return this.run(auth, t, async (tx) => {
      if (!(await tx.selectFrom('workers').select('id').where('id', '=', id).executeTakeFirst())) throw notFound('Trabalhador');
      const type = await tx.selectFrom('qualification_types').select('kind').where('id', '=', input.typeId).executeTakeFirst();
      if (!type) throw new BadRequestException({ code: 'INVALID_REFERENCE', message: 'Tipo de qualificação inexistente.' });
      if ((type.kind === 'TRAINING' || type.kind === 'FITNESS') && input.validUntil === null) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Revise os campos indicados.', fields: [{ field: 'validUntil', message: 'Treinamento e aptidão precisam de data de validade' }] });
      }
      const r = await tx.insertInto('worker_qualifications').values({
        tenant_id: t.tenantId, worker_id: id, type_id: input.typeId, valid_from: input.validFrom, valid_until: input.validUntil,
        evidence: input.evidence ?? null, recorded_by: auth.userId,
      }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'qualification.add', entityType: 'worker', entityId: id, data: input });
      return r;
    });
  }

  @Post('worker-qualifications/:id/revoke')
  @RequirePermission('people.write')
  async revoke(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    requireTenantWide(t, 'people.write');
    if (!uuid.safeParse(id).success) throw notFound('Qualificação');
    const input = parse(revoke, body);
    const r = await this.run(auth, t, async (tx) => {
      const row = await tx.updateTable('worker_qualifications').set({ revoked_at: new Date(), revoked_by: auth.userId, revoke_reason: input.reason })
        .where('id', '=', id).where('revoked_at', 'is', null).returning(['id', 'worker_id']).executeTakeFirst();
      if (row) await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'qualification.revoke', entityType: 'worker', entityId: row.worker_id, data: { qualificationId: id, ...input } });
      return row;
    });
    if (!r) throw notFound('Qualificação ativa');
    return { id: r.id };
  }
}
