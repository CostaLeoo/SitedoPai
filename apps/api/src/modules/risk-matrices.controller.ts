import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { audit } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import { notFound, requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';

const level = z.strictObject({ value: z.number().int().min(1).max(10), label: z.string().trim().min(1).max(60) });
const create = z.strictObject({
  name: z.string().trim().min(1).max(120),
  probabilityLevels: z.array(level).min(2).max(10),
  severityLevels: z.array(level).min(2).max(10),
  classes: z.array(z.strictObject({
    min: z.number().int().min(1), max: z.number().int().min(1),
    label: z.string().trim().min(1).max(60), acceptable: z.boolean(),
  })).min(2).max(10),
});

/** As faixas de classe precisam cobrir todas as pontuações possíveis, sem sobreposição. */
export function validateMatrix(m: z.infer<typeof create>): string | null {
  for (const [name, levels] of [['probabilidade', m.probabilityLevels], ['severidade', m.severityLevels]] as const) {
    if (new Set(levels.map((l) => l.value)).size !== levels.length) return `Níveis de ${name} repetidos.`;
  }
  const scores = new Set<number>();
  for (const p of m.probabilityLevels) for (const s of m.severityLevels) scores.add(p.value * s.value);
  for (const score of scores) {
    const hits = m.classes.filter((c) => score >= c.min && score <= c.max).length;
    if (hits !== 1) return hits === 0 ? `A pontuação ${score} não tem classe.` : `A pontuação ${score} está em mais de uma classe.`;
  }
  if (!m.classes.some((c) => !c.acceptable)) return 'Defina ao menos uma classe de risco não aceitável.';
  return null;
}

@Controller('risk-matrices')
export class RiskMatricesController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('config.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, (tx) =>
      tx.selectFrom('risk_matrices')
        .select(['id', 'name', 'version', 'status', 'probability_levels', 'severity_levels', 'classes', 'published_at'])
        .orderBy('name').orderBy('version').execute());
  }

  @Post()
  @RequirePermission('risk_matrix.write')
  create(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() body: unknown) {
    requireTenantWide(t, 'risk_matrix.write');
    const input = parse(create, body);
    const problem = validateMatrix(input);
    if (problem) throw new BadRequestException({ code: 'INVALID_MATRIX', message: problem });
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const last = await tx.selectFrom('risk_matrices').select((eb) => eb.fn.max('version').as('v'))
        .where('name', '=', input.name).executeTakeFirst();
      const m = await tx.insertInto('risk_matrices').values({
        tenant_id: t.tenantId, name: input.name, version: Number(last?.v ?? 0) + 1, created_by: auth.userId,
        probability_levels: JSON.stringify(input.probabilityLevels), severity_levels: JSON.stringify(input.severityLevels),
        classes: JSON.stringify(input.classes),
      }).returning(['id', 'version', 'status']).executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'risk_matrix.create', entityType: 'risk_matrix', entityId: m.id, data: input });
      return m;
    });
  }

  @Post(':id/publish')
  @RequirePermission('risk_matrix.write')
  async publish(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    requireTenantWide(t, 'risk_matrix.write');
    if (!uuid.safeParse(id).success) throw notFound('Matriz');
    const m = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const row = await tx.updateTable('risk_matrices').set({ status: 'PUBLISHED', published_by: auth.userId, published_at: new Date() })
        .where('id', '=', id).where('status', '=', 'DRAFT').returning(['id', 'status']).executeTakeFirst();
      if (row) await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'risk_matrix.publish', entityType: 'risk_matrix', entityId: id });
      return row;
    });
    if (!m) throw notFound('Matriz em rascunho');
    return m;
  }
}
