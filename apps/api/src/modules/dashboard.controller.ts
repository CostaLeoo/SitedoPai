import { Controller, Get } from '@nestjs/common';
import { sql } from '@sitedopai/db';
import { unitScope } from '../authz/permissions';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import type { AuthContext, TenantContext } from '../common/request';
import { DbService } from '../db.service';
import { PtService } from '../pt/pt.service';

/**
 * Visão geral: contagens REAIS por situação e o que precisa de atenção,
 * sempre dentro das unidades que a pessoa pode ver. Nenhum indicador fictício.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly db: DbService, private readonly pts: PtService) {}

  @Get()
  @RequirePermission('apr.read')
  get(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    const aprScope = unitScope(t.assignments, 'apr.read');
    const ptScope = unitScope(t.assignments, 'pt.read');
    const inScope = (s: typeof aprScope) => (s.all ? sql<boolean>`true` : s.unitIds.length ? sql<boolean>`unit_id = ANY(${s.unitIds}::uuid[])` : sql<boolean>`false`);
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await this.pts.syncExpiry(tx, t.tenantId);
      const aprCounts = await tx.selectFrom('aprs').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where(inScope(aprScope)).groupBy('status').execute();
      const ptCounts = await tx.selectFrom('work_permits').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where(inScope(ptScope)).groupBy('status').execute();
      const validNow = await tx.selectFrom('work_permits').select((eb) => eb.fn.countAll<string>().as('n')).where(inScope(ptScope))
        .where('status', 'in', ['RELEASED', 'IN_EXECUTION']).where('starts_at', '<=', new Date()).where('ends_at', '>', new Date()).executeTakeFirstOrThrow();
      const aprsAttention = await tx.selectFrom('aprs').select(['id', 'number', 'revision', 'status', 'location', 'service_description', 'updated_at'])
        .where(inScope(aprScope)).where('status', 'in', ['IN_REVIEW', 'RETURNED']).orderBy('updated_at', 'desc').limit(8).execute();
      const ptsAttention = await tx.selectFrom('work_permits').select(['id', 'number', 'status', 'location', 'description', 'starts_at', 'ends_at', 'updated_at'])
        .where(inScope(ptScope)).where('status', 'in', ['IN_ANALYSIS', 'AWAITING_CORRECTION', 'AWAITING_APPROVAL', 'SUSPENDED']).orderBy('updated_at', 'desc').limit(8).execute();
      const recentAprs = await tx.selectFrom('aprs').select(['id', 'number', 'revision', 'status', 'location', 'updated_at'])
        .where(inScope(aprScope)).orderBy('updated_at', 'desc').limit(5).execute();
      const recentPts = await tx.selectFrom('work_permits').select(['id', 'number', 'status', 'location', 'updated_at'])
        .where(inScope(ptScope)).orderBy('updated_at', 'desc').limit(5).execute();
      const toMap = (rows: { status: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      return {
        aprs: toMap(aprCounts),
        pts: toMap(ptCounts),
        ptsValidNow: Number(validNow.n),
        attention: {
          aprs: aprsAttention,
          pts: ptsAttention,
        },
        recent: [
          ...recentAprs.map((r) => ({ kind: 'apr' as const, ...r })),
          ...recentPts.map((r) => ({ kind: 'pt' as const, ...r })),
        ].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)).slice(0, 8),
      };
    });
  }
}
