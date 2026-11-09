import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { audit, Tx } from '@sitedopai/db';
import { Auth, RequirePermission, Tenant, AllowWhenRestricted } from '../common/decorators';
import { notFound, requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';
import { scopedDocument } from './documents.controller';

const docType = z.enum(['apr', 'work_permit']);
const ruleBody = z.object({
  documentType: docType,
  /** Opcional: só PTs deste tipo. Vazio = todos os documentos do tipo. */
  ptTypeName: z.string().trim().min(1).max(200).optional(),
  minYears: z.number().int().min(1).max(100),
  source: z.enum(['LEGAL', 'CONTRACT', 'INTERNAL']),
  /** Fundamento: norma, cláusula contratual ou política interna, conforme o jurídico. */
  basis: z.string().trim().min(5).max(1000),
}).strict();
const holdBody = z.object({ documentType: docType, documentId: z.string().uuid(), reason: z.string().trim().min(5).max(1000) }).strict();
const releaseBody = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();

const FINAL_APR = new Set(['APPROVED', 'CANCELLED']);
const FINAL_PT = new Set(['EXPIRED', 'CLOSED', 'CANCELLED']);

function addYears(d: Date, y: number) {
  const r = new Date(d);
  r.setUTCFullYear(r.getUTCFullYear() + y);
  return r;
}

/**
 * Regras de guarda e retenções especiais. O sistema NÃO apaga documentos:
 * o relatório só indica o que já cumpriu todos os prazos cadastrados. Sem regra
 * aplicável, o documento fica sob guarda indefinida.
 */
@Controller()
export class RetentionController {
  constructor(private readonly db: DbService) {}

  private ctx(auth: AuthContext, t: TenantContext) {
    return { tenantId: t.tenantId, userId: auth.userId };
  }

  @Get('retention-rules')
  @RequirePermission('retention.read')
  rules(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    requireTenantWide(t, 'retention.read');
    return this.db.run(this.ctx(auth, t), (tx) => tx.selectFrom('retention_rules').selectAll().orderBy('created_at', 'desc').execute());
  }

  @Post('retention-rules')
  @RequirePermission('retention.write')
  createRule(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown) {
    requireTenantWide(t, 'retention.write');
    const r = parse(ruleBody, b);
    if (r.ptTypeName && r.documentType !== 'work_permit') throw new BadRequestException({ code: 'PT_TYPE_ONLY_FOR_PT', message: 'Tipo de PT só se aplica a regras de PT.' });
    return this.db.run(this.ctx(auth, t), async (tx) => {
      const row = await tx.insertInto('retention_rules').values({
        tenant_id: t.tenantId, document_type: r.documentType, pt_type_name: r.ptTypeName ?? null, min_years: r.minYears,
        source: r.source, basis: r.basis, created_by: auth.userId,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'retention_rule.create', entityType: 'retention_rule', entityId: row.id, data: r });
      return row;
    });
  }

  /** Regras de origem legal não podem ser desativadas (o banco também impede). */
  @Post('retention-rules/:id/deactivate')
  @RequirePermission('retention.write')
  @HttpCode(200)
  deactivate(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    requireTenantWide(t, 'retention.write');
    if (!uuid.safeParse(id).success) throw notFound('Regra');
    return this.db.run(this.ctx(auth, t), async (tx) => {
      const rule = await tx.selectFrom('retention_rules').select(['id', 'source', 'active']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!rule) throw notFound('Regra');
      if (rule.source === 'LEGAL') throw new BadRequestException({ code: 'LEGAL_RULE', message: 'Regra de origem legal não pode ser desativada.' });
      if (!rule.active) throw new BadRequestException({ code: 'ALREADY_INACTIVE', message: 'A regra já está desativada.' });
      const row = await tx.updateTable('retention_rules').set({ active: false, deactivated_by: auth.userId, deactivated_at: new Date() })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'retention_rule.deactivate', entityType: 'retention_rule', entityId: id });
      return row;
    });
  }

  @Get('legal-holds')
  @RequirePermission('retention.read')
  holds(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    requireTenantWide(t, 'retention.read');
    return this.db.run(this.ctx(auth, t), (tx) => tx.selectFrom('legal_holds').selectAll().orderBy('created_at', 'desc').execute());
  }

  @Post('legal-holds')
  @AllowWhenRestricted()
  @RequirePermission('retention.write')
  createHold(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Body() b: unknown) {
    requireTenantWide(t, 'retention.write');
    const h = parse(holdBody, b);
    return this.db.run(this.ctx(auth, t), async (tx) => {
      await scopedDocument(tx, t, h.documentType, h.documentId);
      const row = await tx.insertInto('legal_holds').values({
        tenant_id: t.tenantId, document_type: h.documentType, document_id: h.documentId, reason: h.reason, created_by: auth.userId,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'legal_hold.create', entityType: h.documentType, entityId: h.documentId, data: { holdId: row.id } });
      return row;
    });
  }

  @Post('legal-holds/:id/release')
  @RequirePermission('retention.write')
  @HttpCode(200)
  release(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Body() b: unknown) {
    requireTenantWide(t, 'retention.write');
    if (!uuid.safeParse(id).success) throw notFound('Retenção');
    const { reason } = parse(releaseBody, b);
    return this.db.run(this.ctx(auth, t), async (tx) => {
      const h = await tx.selectFrom('legal_holds').select(['id', 'released_at', 'document_type', 'document_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!h) throw notFound('Retenção');
      if (h.released_at) throw new BadRequestException({ code: 'ALREADY_RELEASED', message: 'A retenção já foi liberada.' });
      const row = await tx.updateTable('legal_holds').set({ released_by: auth.userId, released_at: new Date(), release_reason: reason })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'legal_hold.release', entityType: h.document_type, entityId: h.document_id, data: { holdId: id, reason } });
      return row;
    });
  }

  /**
   * Relatório de guarda. Para cada APR e PT: data final, regras aplicáveis,
   * retenções e a situação. "Elegível" só quando há regra aplicável, o documento
   * está numa situação final, todos os prazos passaram e não há retenção ativa.
   * Nada é apagado; a decisão de descarte é da empresa.
   */
  @Get('retention/report')
  @RequirePermission('retention.read')
  report(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    requireTenantWide(t, 'retention.read');
    return this.db.run(this.ctx(auth, t), (tx) => this.buildReport(tx, new Date()));
  }

  async buildReport(tx: Tx, now: Date) {
    const [rules, holds, aprs, pts] = await Promise.all([
      tx.selectFrom('retention_rules').selectAll().where('active', '=', true).execute(),
      tx.selectFrom('legal_holds').select(['document_type', 'document_id']).where('released_at', 'is', null).execute(),
      tx.selectFrom('aprs').select(['id', 'number', 'revision', 'status', 'decided_at']).execute(),
      tx.selectFrom('work_permits').innerJoin('pt_types', 'pt_types.id', 'work_permits.pt_type_id')
        .select(['work_permits.id', 'work_permits.number', 'work_permits.status', 'work_permits.closed_at', 'work_permits.ends_at', 'pt_types.name as type_name']).execute(),
    ]);
    const held = new Set(holds.map((h) => `${h.document_type}:${h.document_id}`));
    const docs = [
      ...aprs.map((a) => ({ type: 'apr' as const, id: a.id, number: a.revision ? `${a.number} rev. ${a.revision}` : a.number, status: a.status,
        final: FINAL_APR.has(a.status), finalAt: FINAL_APR.has(a.status) ? a.decided_at : null, ptType: null as string | null })),
      ...pts.map((p) => ({ type: 'work_permit' as const, id: p.id, number: p.number, status: p.status,
        final: FINAL_PT.has(p.status), finalAt: FINAL_PT.has(p.status) ? (p.closed_at ?? p.ends_at) : null, ptType: p.type_name })),
    ];
    const items = docs.map((d) => {
      const applicable = rules.filter((r) => r.document_type === d.type && (!r.pt_type_name || r.pt_type_name === d.ptType));
      const years = applicable.length ? Math.max(...applicable.map((r) => r.min_years)) : null;
      const retainUntil = d.finalAt && years ? addYears(d.finalAt, years) : null;
      let situation: 'LEGAL_HOLD' | 'NOT_FINAL' | 'NO_RULE' | 'RETAINED' | 'ELIGIBLE_FOR_REVIEW';
      if (held.has(`${d.type}:${d.id}`)) situation = 'LEGAL_HOLD';
      else if (!d.final || !d.finalAt) situation = 'NOT_FINAL';
      else if (!years) situation = 'NO_RULE';
      else if (retainUntil! > now) situation = 'RETAINED';
      else situation = 'ELIGIBLE_FOR_REVIEW';
      return { documentType: d.type, documentId: d.id, number: d.number, status: d.status, finalAt: d.finalAt,
        ruleIds: applicable.map((r) => r.id), retainUntil, situation };
    });
    const summary: Record<string, number> = {};
    for (const i of items) summary[i.situation] = (summary[i.situation] ?? 0) + 1;
    return { generatedAt: now, automaticDeletion: false, summary, items };
  }
}
