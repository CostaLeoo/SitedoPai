import { CanActivate, ExecutionContext, ForbiddenException, Injectable, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NO_TENANT, PLATFORM, PUBLIC, SAFETY } from '../common/decorators';
import { audit } from '@sitedopai/db';
import type { AppRequest } from '../common/request';
import { PRIVILEGED_ROLES } from '../authz/permissions';
import { DbService } from '../db.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Define a empresa ativa a partir do cabeçalho X-Tenant-Id, mas só depois de
 * confirmar no banco um vínculo ATIVO do usuário com ela. Também aplica:
 * MFA obrigatório para papéis privilegiados e bloqueio de escrita em empresa
 * em modo somente leitura ou encerrada.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const auth = req.auth!;

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM, targets)) {
      const isAdmin = await this.db.run({ userId: auth.userId }, (tx) =>
        tx.selectFrom('platform_admins').select('user_id').executeTakeFirst());
      if (!isAdmin) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Área restrita à administração da plataforma.' });
      if (!auth.mfa) throw mfaRequired();
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, targets)) return true;

    const tenantId = String(req.headers['x-tenant-id'] ?? '');
    if (!UUID.test(tenantId)) {
      throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'Selecione uma empresa.' });
    }

    const found = await this.db.run({ tenantId, userId: auth.userId }, async (tx) => {
      const m = await tx
        .selectFrom('memberships')
        .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
        .select(['memberships.id', 'memberships.status', 'tenants.status as tenant_status'])
        .where('memberships.tenant_id', '=', tenantId)
        .where('memberships.user_id', '=', auth.userId)
        .executeTakeFirst();
      if (!m || m.status === 'SUSPENDED') return null;
      if (m.status === 'INVITED') {
        // Primeiro acesso do convidado: o vínculo passa a ativo e fica registrado.
        await tx.updateTable('memberships').set({ status: 'ACTIVE' }).where('id', '=', m.id).execute();
        await audit(tx, tenantId, { actorUserId: auth.userId, action: 'membership.activate', entityType: 'membership', entityId: m.id });
      }
      const assignments = await tx
        .selectFrom('role_assignments')
        .select(['role', 'scope_type', 'unit_id'])
        .where('membership_id', '=', m.id)
        .execute();
      return { m, assignments };
    });
    // Mesma resposta para "empresa não existe" e "sem vínculo": não revela empresas.
    if (!found) throw new ForbiddenException({ code: 'NO_ACCESS', message: 'Você não tem acesso a esta empresa.' });

    const assignments = found.assignments.map((a) => ({ role: a.role, scopeType: a.scope_type, unitId: a.unit_id }));
    if (!auth.mfa && assignments.some((a) => PRIVILEGED_ROLES.includes(a.role))) throw mfaRequired();

    const restricted = found.m.tenant_status === 'READ_ONLY' || found.m.tenant_status === 'CLOSED';
    if (restricted && !SAFE_METHODS.has(req.method) && !this.reflector.getAllAndOverride<boolean>(SAFETY, targets)) {
      throw new ForbiddenException({
        code: 'TENANT_READ_ONLY',
        message: 'A conta da empresa está em modo somente leitura. Consultas, exportação e ações de segurança das PTs em andamento (suspender, registrar saída, medir gás, encerrar) continuam disponíveis.',
      });
    }

    req.tenant = { tenantId, membershipId: found.m.id, tenantStatus: found.m.tenant_status, assignments };
    return true;
  }
}

function mfaRequired() {
  return new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Seu perfil exige verificação em duas etapas. Ative-a e faça login novamente.' });
}
