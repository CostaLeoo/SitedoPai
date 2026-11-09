import { enforcePlanLimit } from '../billing/limits';
import { Body, Controller, Get, NotFoundException, Param, Patch, Post, ForbiddenException, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { audit } from '@sitedopai/db';
import { canOnUnit, unitScope } from '../authz/permissions';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const UF = z.string().regex(/^[A-Z]{2}$/, 'Use a sigla da UF, ex.: SP');
const createUnit = z.strictObject({
  name: z.string().trim().min(1, 'Informe o nome').max(120),
  code: z.string().trim().min(1, 'Informe o código').max(30),
  city: z.string().trim().max(120).optional(),
  state: UF.optional(),
});
const updateUnit = createUnit.partial().extend({ active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nada para alterar');
const createSector = z.strictObject({ name: z.string().trim().min(1, 'Informe o nome').max(120) });

const notFound = () => new NotFoundException({ code: 'NOT_FOUND', message: 'Unidade não encontrada.' });

@Controller('units')
export class UnitsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('unit.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    const scope = unitScope(t.assignments, 'unit.read');
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, (tx) => {
      let q = tx.selectFrom('units').select(['id', 'name', 'code', 'city', 'state', 'active']).orderBy('name');
      if (!scope.all) q = scope.unitIds.length ? q.where('id', 'in', scope.unitIds) : q.where(() => false as never);
      return q.execute();
    });
  }

  @Post()
  @RequirePermission('unit.write')
  create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    const input = parse(createUnit, body);
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await enforcePlanLimit(tx, t.tenantId, 'units');
      const unit = await tx
        .insertInto('units')
        .values({ tenant_id: t.tenantId, name: input.name, code: input.code, city: input.city ?? null, state: input.state ?? null })
        .returning(['id', 'name', 'code', 'city', 'state', 'active'])
        .executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'unit.create', entityType: 'unit', entityId: unit.id, data: input });
      return unit;
    });
  }

  @Get(':id')
  @RequirePermission('unit.read')
  async get(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    if (!uuid.safeParse(id).success || !canOnUnit(t.assignments, 'unit.read', id)) throw notFound();
    const unit = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, (tx) =>
      tx.selectFrom('units').select(['id', 'name', 'code', 'city', 'state', 'active']).where('id', '=', id).executeTakeFirst());
    if (!unit) throw notFound();
    return unit;
  }

  @Patch(':id')
  @RequirePermission('unit.write')
  async update(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    if (!uuid.safeParse(id).success) throw notFound();
    const input = parse(updateUnit, body);
    if (!canOnUnit(t.assignments, 'unit.write', id)) throw notFound();
    const unit = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const u = await tx.updateTable('units').set(input).where('id', '=', id)
        .returning(['id', 'name', 'code', 'city', 'state', 'active']).executeTakeFirst();
      if (u) await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'unit.update', entityType: 'unit', entityId: id, data: input });
      return u;
    });
    if (!unit) throw notFound();
    return unit;
  }

  @Get(':id/sectors')
  @RequirePermission('unit.read')
  async sectors(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    if (!uuid.safeParse(id).success || !canOnUnit(t.assignments, 'unit.read', id)) throw notFound();
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const unit = await tx.selectFrom('units').select('id').where('id', '=', id).executeTakeFirst();
      if (!unit) throw notFound();
      return tx.selectFrom('sectors').select(['id', 'name', 'active']).where('unit_id', '=', id).orderBy('name').execute();
    });
  }

  @Post(':id/sectors')
  @HttpCode(201)
  @RequirePermission('sector.write')
  async createSector(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    if (!uuid.safeParse(id).success) throw notFound();
    const input = parse(createSector, body);
    if (!canOnUnit(t.assignments, 'unit.read', id)) throw notFound();
    if (!canOnUnit(t.assignments, 'sector.write', id)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Seu perfil não permite esta ação nesta unidade.' });
    }
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const unit = await tx.selectFrom('units').select('id').where('id', '=', id).executeTakeFirst();
      if (!unit) throw notFound();
      const s = await tx.insertInto('sectors').values({ tenant_id: t.tenantId, unit_id: id, name: input.name })
        .returning(['id', 'name', 'active']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'sector.create', entityType: 'sector', entityId: s.id, data: { unitId: id, ...input } });
      return s;
    });
  }
}
