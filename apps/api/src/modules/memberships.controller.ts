import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { audit, ROLES, sql } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const roleInput = z.strictObject({ role: z.enum(ROLES), unitId: z.string().uuid().optional() })
  .refine((r) => r.role !== 'COMPANY_ADMIN' || !r.unitId, 'Administrador da empresa vale para a empresa inteira');
const invite = z.strictObject({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  displayName: z.string().trim().min(1, 'Informe o nome').max(120),
  roles: z.array(roleInput).min(1, 'Informe ao menos um papel').max(20),
});
const updateStatus = z.strictObject({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

@Controller('memberships')
export class MembershipsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('membership.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const rows = await tx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select(['memberships.id', 'memberships.status', 'users.email', 'users.display_name'])
        .orderBy('users.display_name')
        .execute();
      const roles = await tx.selectFrom('role_assignments').select(['membership_id', 'role', 'scope_type', 'unit_id'])
        .where('tenant_id', '=', t.tenantId).execute();
      return rows.map((m) => ({
        id: m.id,
        status: m.status,
        email: m.email,
        displayName: m.display_name,
        roles: roles.filter((r) => r.membership_id === m.id).map((r) => ({ role: r.role, scopeType: r.scope_type, unitId: r.unit_id })),
      }));
    });
  }

  @Post()
  @RequirePermission('membership.write')
  create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    const input = parse(invite, body);
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const r = await sql<{ id: string }>`SELECT invite_user(${input.email}, ${input.displayName}) AS id`.execute(tx);
      const userId = r.rows[0]!.id;
      const m = await tx.insertInto('memberships').values({ tenant_id: t.tenantId, user_id: userId, status: 'INVITED' })
        .returning(['id', 'status']).executeTakeFirstOrThrow();
      await tx.insertInto('role_assignments').values(
        input.roles.map((ro) => ({
          tenant_id: t.tenantId, membership_id: m.id, role: ro.role,
          scope_type: ro.unitId ? ('UNIT' as const) : ('TENANT' as const), unit_id: ro.unitId ?? null,
        })),
      ).execute();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'membership.invite', entityType: 'membership', entityId: m.id, data: { email: input.email, roles: input.roles } });
      return { id: m.id, status: m.status };
    });
  }

  @Patch(':id')
  @RequirePermission('membership.write')
  async update(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const notFound = new NotFoundException({ code: 'NOT_FOUND', message: 'Vínculo não encontrado.' });
    if (!uuid.safeParse(id).success) throw notFound;
    const input = parse(updateStatus, body);
    if (id === t.membershipId) {
      throw new BadRequestException({ code: 'SELF_CHANGE', message: 'Você não pode alterar o seu próprio acesso.' });
    }
    const m = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.updateTable('memberships').set({ status: input.status }).where('id', '=', id)
        .where('tenant_id', '=', t.tenantId).returning(['id', 'status']).executeTakeFirst();
      if (row) await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'membership.status', entityType: 'membership', entityId: id, data: input });
      return row;
    });
    if (!m) throw notFound;
    return m;
  }
}
