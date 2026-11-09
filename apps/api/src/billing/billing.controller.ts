import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, sql } from '@sitedopai/db';
import { Auth, PlatformOnly, Public, RequirePermission, Tenant } from '../common/decorators';
import { notFound, requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db.service';
import { BillingService } from './billing.service';
import { SimulatedProvider } from './provider';

const planBody = z.strictObject({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Código: letras minúsculas, números e hífen'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  priceCents: z.number().int().positive().max(100_000_000),
  maxUsers: z.number().int().positive().nullable(),
  maxUnits: z.number().int().positive().nullable(),
});
const subscribeBody = z.strictObject({
  planId: z.string().uuid(),
  /** Tolerância após o vencimento, decidida na contratação. */
  graceDays: z.number().int().min(0).max(90),
});
const reasonBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });
const statusBody = z.strictObject({ status: z.enum(['ACTIVE', 'READ_ONLY', 'CLOSED']), reason: z.string().trim().min(5).max(500) });

const plan = (p: { id: string; code: string; name: string; description: string | null; price_cents: number; max_users: number | null; max_units: number | null; active: boolean }) => ({
  id: p.id, code: p.code, name: p.name, description: p.description, priceCents: p.price_cents, maxUsers: p.max_users, maxUnits: p.max_units, active: p.active,
});

/** Painel comercial: planos, assinaturas e cobranças. Sem acesso a APR/PT. */
@Controller('platform')
@PlatformOnly()
export class PlatformBillingController {
  constructor(private readonly db: DbService, private readonly billing: BillingService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('plans')
  async plans(@Auth() auth: AuthContext) {
    return (await this.db.run({ userId: auth.userId }, (tx) => tx.selectFrom('plans').selectAll().orderBy('price_cents').execute())).map(plan);
  }

  @Post('plans')
  createPlan(@Auth() auth: AuthContext, @Body() b: unknown) {
    const p = parse(planBody, b);
    return this.db.run({ userId: auth.userId }, async (tx) => plan(await tx.insertInto('plans').values({
      code: p.code, name: p.name, description: p.description ?? null, price_cents: p.priceCents, max_users: p.maxUsers, max_units: p.maxUnits, created_by: auth.userId,
    }).returningAll().executeTakeFirstOrThrow()));
  }

  /** Só ativa/desativa: preço e limites ficam como estão (assinaturas guardam cópia). */
  @Patch('plans/:id')
  setActive(@Auth() auth: AuthContext, @Param('id') id: string, @Body() b: unknown) {
    if (!uuid.safeParse(id).success) throw notFound('Plano');
    const { active } = parse(z.strictObject({ active: z.boolean() }), b);
    return this.db.run({ userId: auth.userId }, async (tx) => {
      const row = await tx.updateTable('plans').set({ active }).where('id', '=', id).returningAll().executeTakeFirst();
      if (!row) throw notFound('Plano');
      return plan(row);
    });
  }

  /** Empresas com situação comercial e contagens de uso (sem conteúdo). */
  @Get('billing/overview')
  async overview(@Auth() auth: AuthContext) {
    return (await this.db.run({ userId: auth.userId }, (tx) => sql<Record<string, unknown>>`SELECT * FROM platform_billing_overview()`.execute(tx))).rows;
  }

  @Get('tenants/:id/billing')
  tenantBilling(@Auth() auth: AuthContext, @Param('id') id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Empresa');
    return this.db.run({ tenantId: id, userId: auth.userId }, async (tx) => {
      const t = await tx.selectFrom('tenants').select(['id', 'legal_name', 'status']).where('id', '=', id).executeTakeFirst();
      if (!t) throw notFound('Empresa');
      const subs = await tx.selectFrom('subscriptions').selectAll().orderBy('created_at', 'desc').execute();
      const invoices = await tx.selectFrom('invoices').selectAll().orderBy('due_date', 'desc').execute();
      return { tenant: t, subscriptions: subs, invoices };
    });
  }

  @Post('tenants/:id/subscription')
  subscribe(@Auth() auth: AuthContext, @Param('id') id: string, @Body() b: unknown) {
    if (!uuid.safeParse(id).success) throw notFound('Empresa');
    const s = parse(subscribeBody, b);
    return this.billing.subscribe(auth.userId, id, s.planId, s.graceDays);
  }

  @Post('tenants/:id/subscription/cancel')
  @HttpCode(200)
  cancel(@Auth() auth: AuthContext, @Param('id') id: string, @Body() b: unknown) {
    if (!uuid.safeParse(id).success) throw notFound('Empresa');
    return this.billing.cancel(auth.userId, id, parse(reasonBody, b).reason);
  }

  /**
   * Situação definida manualmente (ex.: piloto sem cobrança, encerramento de
   * contrato). ENCERRADA não apaga nada: a empresa continua podendo consultar
   * e exportar seus documentos.
   */
  @Post('tenants/:id/status')
  @HttpCode(200)
  setStatus(@Auth() auth: AuthContext, @Param('id') id: string, @Body() b: unknown) {
    if (!uuid.safeParse(id).success) throw notFound('Empresa');
    const s = parse(statusBody, b);
    return this.db.run({ tenantId: id, userId: auth.userId }, async (tx) => {
      const t = await tx.selectFrom('tenants').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw notFound('Empresa');
      await tx.updateTable('tenants').set({ status: s.status }).where('id', '=', id).execute();
      await audit(tx, id, { actorUserId: auth.userId, action: 'tenant.status_manual', entityType: 'tenant', entityId: id, data: { from: t.status, to: s.status, reason: s.reason } });
      return { id, status: s.status };
    });
  }

  @Post('billing/sync')
  @HttpCode(200)
  async syncAll() {
    return { tenants: await this.billing.syncAll() };
  }

  /**
   * SÓ com o provedor simulado: gera um aviso assinado (como o provedor faria)
   * para testar cobrança, pagamento e atraso sem dinheiro de verdade.
   */
  @Post('billing/simulate')
  @HttpCode(200)
  async simulate(@Auth() auth: AuthContext, @Body() b: unknown) {
    if (!(this.billing.provider instanceof SimulatedProvider)) throw notFound('Rota');
    const s = parse(z.strictObject({
      tenantId: z.string().uuid(),
      type: z.enum(['charge.created', 'charge.paid', 'charge.failed']),
      chargeRef: z.string().max(100).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), b);
    const sub = await this.db.run({ tenantId: s.tenantId, userId: auth.userId }, (tx) =>
      tx.selectFrom('subscriptions').selectAll().where('status', '<>', 'CANCELED').executeTakeFirst());
    if (!sub) throw new BadRequestException({ code: 'NO_SUBSCRIPTION', message: 'A empresa não tem assinatura ativa.' });
    const body = JSON.stringify({
      eventId: `evt_${randomUUID()}`, type: s.type, subscriptionRef: sub.provider_subscription_ref,
      chargeRef: s.chargeRef ?? `ch_${randomUUID()}`, amountCents: sub.price_cents,
      dueDate: s.dueDate ?? new Date().toISOString().slice(0, 10),
      ...(s.type === 'charge.paid' ? { paidAt: new Date().toISOString(), receiptUrl: 'https://pagamentos.exemplo.test/recibo' } : {}),
      ...(s.type === 'charge.failed' ? { failureReason: 'Pagamento recusado (simulação)' } : {}),
    });
    const sim = this.billing.provider as SimulatedProvider;
    return this.billing.handleWebhook(Buffer.from(body), { 'x-signature': sim.sign(body) });
  }
}

/** Avisos do provedor de pagamentos: públicos, autenticados por assinatura HMAC. */
@Controller('billing/webhooks')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post(':provider')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  webhook(@Param('provider') provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    if (provider !== this.billing.provider.name || !req.rawBody) throw notFound('Rota');
    return this.billing.handleWebhook(req.rawBody, req.headers);
  }
}

/** A empresa vê a própria assinatura e as cobranças (sem dados de cartão). */
@Controller('billing')
export class CompanyBillingController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('billing.read')
  get(@Auth() auth: AuthContext, @Tenant() t: TenantContext) {
    requireTenantWide(t, 'billing.read');
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const sub = await tx.selectFrom('subscriptions').select(['id', 'plan_name', 'price_cents', 'max_users', 'max_units', 'status', 'grace_days', 'current_period_end', 'canceled_at', 'created_at'])
        .orderBy('created_at', 'desc').executeTakeFirst();
      const invoices = await tx.selectFrom('invoices').select(['id', 'amount_cents', 'due_date', 'status', 'paid_at', 'failure_reason', 'receipt_url'])
        .orderBy('due_date', 'desc').execute();
      const usage = {
        activeUsers: Number((await tx.selectFrom('memberships').select((eb) => eb.fn.countAll().as('n')).where('status', '<>', 'SUSPENDED').executeTakeFirstOrThrow()).n),
        units: Number((await tx.selectFrom('units').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
      };
      return { tenantStatus: t.tenantStatus, subscription: sub ?? null, invoices, usage };
    });
  }
}
