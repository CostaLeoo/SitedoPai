import { Controller, Get } from '@nestjs/common';
import { Auth, NoTenant, Public } from '../common/decorators';
import type { AuthContext } from '../common/request';
import { DbService } from '../db.service';

@Controller()
export class SessionController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Usuário logado e as empresas em que tem vínculo, com os papéis. */
  @NoTenant()
  @Get('me')
  me(@Auth() auth: AuthContext) {
    return this.db.run({ userId: auth.userId }, async (tx) => {
      const user = await tx.selectFrom('users').select(['id', 'email', 'display_name']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
      const memberships = await tx
        .selectFrom('memberships')
        .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
        .select(['memberships.id', 'memberships.status', 'tenants.id as tenant_id', 'tenants.legal_name', 'tenants.trade_name'])
        .where('memberships.user_id', '=', auth.userId)
        .execute();
      const roles = await tx
        .selectFrom('role_assignments')
        .select(['membership_id', 'role', 'scope_type', 'unit_id'])
        .where('membership_id', 'in', memberships.length ? memberships.map((m) => m.id) : ['00000000-0000-0000-0000-000000000000'])
        .execute();
      return {
        user: { id: user.id, email: user.email, displayName: user.display_name, mfa: auth.mfa },
        tenants: memberships.map((m) => ({
          tenantId: m.tenant_id,
          name: m.trade_name ?? m.legal_name,
          status: m.status,
          roles: roles.filter((r) => r.membership_id === m.id).map((r) => ({ role: r.role, scopeType: r.scope_type, unitId: r.unit_id })),
        })),
      };
    });
  }
}
