import { Body, Controller, Get, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, sql } from '@sitedopai/db';
import { isValidCnpj, onlyDigits } from '../common/cnpj';
import { Auth, PlatformOnly } from '../common/decorators';
import type { AuthContext } from '../common/request';
import { parse } from '../common/validation';
import { DbService } from '../db.service';

const createTenant = z.strictObject({
  legalName: z.string().trim().min(1, 'Informe a razão social').max(200),
  tradeName: z.string().trim().max(200).optional(),
  cnpj: z.string().transform(onlyDigits).refine(isValidCnpj, 'CNPJ inválido'),
  admin: z.strictObject({
    email: z.string().trim().toLowerCase().email('E-mail inválido'),
    displayName: z.string().trim().min(1, 'Informe o nome').max(120),
  }),
});

/**
 * Área do administrador da plataforma. Só dados comerciais: nenhuma rota aqui
 * lê unidades, pessoas, APRs ou PTs de clientes.
 */
@Controller('platform')
@PlatformOnly()
export class PlatformController {
  constructor(private readonly db: DbService) {}

  @Get('tenants')
  async list(@Auth() auth: AuthContext) {
    const r = await this.db.run({ userId: auth.userId }, (tx) => sql<Record<string, unknown>>`SELECT * FROM platform_list_tenants()`.execute(tx));
    return r.rows;
  }

  /** Cadastra a empresa e convida o primeiro administrador dela. */
  @Post('tenants')
  create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createTenant, body);
    const tenantId = randomUUID();
    return this.db.run({ tenantId, userId: auth.userId }, async (tx) => {
      await tx.insertInto('tenants').values({ id: tenantId, legal_name: input.legalName, trade_name: input.tradeName ?? null, cnpj: input.cnpj }).execute();
      const r = await sql<{ id: string }>`SELECT invite_user(${input.admin.email}, ${input.admin.displayName}) AS id`.execute(tx);
      const m = await tx.insertInto('memberships').values({ tenant_id: tenantId, user_id: r.rows[0]!.id, status: 'INVITED' })
        .returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('role_assignments').values({ tenant_id: tenantId, membership_id: m.id, role: 'COMPANY_ADMIN', scope_type: 'TENANT' }).execute();
      await audit(tx, tenantId, { actorUserId: auth.userId, action: 'tenant.create', entityType: 'tenant', entityId: tenantId, data: { cnpj: input.cnpj, adminEmail: input.admin.email } });
      return { id: tenantId };
    });
  }
}
