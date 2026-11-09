import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { sql } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import type { AuthContext, TenantContext } from '../common/request';
import { parse } from '../common/validation';
import { DbService } from '../db.service';

const page = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('audit-events')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Query() q: unknown) {
    const { afterSeq, limit } = parse(page, q);
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const rows = await tx.selectFrom('audit_events')
        .select(['seq', 'occurred_at', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'data', 'hash'])
        .where('seq', '>', String(afterSeq) as never).orderBy('seq').limit(limit).execute();
      return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
    });
  }

  @Get('verify')
  @RequirePermission('audit.read')
  async verify(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    const r = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, (tx) =>
      sql<{ broken: string | null; total: string }>`SELECT audit_verify() AS broken, (SELECT count(*) FROM audit_events) AS total`.execute(tx));
    const row = r.rows[0]!;
    return { intact: row.broken === null, brokenAtSeq: row.broken === null ? null : Number(row.broken), events: Number(row.total) };
  }
}
