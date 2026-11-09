import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit, sql, Tx } from '@sitedopai/db';
import { notFound } from '../common/guards';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db.service';
import { BillingEvent, PAYMENT_PROVIDER, PaymentProvider } from './provider';

const event = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(['charge.created', 'charge.paid', 'charge.failed', 'charge.voided', 'subscription.canceled']),
  subscriptionRef: z.string().min(1).max(200),
  chargeRef: z.string().min(1).max(200).optional(),
  amountCents: z.number().int().positive().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paidAt: z.string().datetime({ offset: true }).optional(),
  failureReason: z.string().max(500).optional(),
  receiptUrl: z.string().url().startsWith('https://').max(1000).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Cobrança');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    @Inject(PAYMENT_PROVIDER) readonly provider: PaymentProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Reavalia periodicamente vencimentos e tolerâncias (mesmo sem webhook). */
  onModuleInit() {
    const minutes = this.config.BILLING_SYNC_INTERVAL_MINUTES;
    if (minutes > 0) {
      this.timer = setInterval(() => this.syncAll().catch((e) => this.log.error(`sincronização falhou: ${String(e)}`)), minutes * 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll() {
    return this.db.run({}, async (tx) => (await sql<{ n: number }>`SELECT billing_sync_all() AS n`.execute(tx)).rows[0]!.n);
  }

  sync(tx: Tx, tenantId: string) {
    return sql<{ s: string }>`SELECT billing_sync_tenant(${tenantId}::uuid) AS s`.execute(tx).then((r) => r.rows[0]!.s);
  }

  /** Contrata um plano para a empresa (administrador da plataforma). */
  async subscribe(actorId: string, tenantId: string, planId: string, graceDays: number) {
    return this.db.run({ tenantId, userId: actorId }, async (tx) => {
      const tenant = await tx.selectFrom('tenants').select(['id', 'cnpj', 'legal_name', 'status']).where('id', '=', tenantId).executeTakeFirst();
      if (!tenant) throw notFound('Empresa');
      const plan = await tx.selectFrom('plans').selectAll().where('id', '=', planId).executeTakeFirst();
      if (!plan || !plan.active) throw new BadRequestException({ code: 'PLAN_UNAVAILABLE', message: 'Plano inexistente ou inativo.' });
      const open = await tx.selectFrom('subscriptions').select('id').where('status', '<>', 'CANCELED').executeTakeFirst();
      if (open) throw new ConflictException({ code: 'SUBSCRIPTION_EXISTS', message: 'A empresa já tem uma assinatura ativa. Cancele antes de contratar outra.' });
      const ext = await this.provider.createSubscription({ tenantId, cnpj: tenant.cnpj, legalName: tenant.legal_name, priceCents: plan.price_cents, planName: plan.name });
      const sub = await tx.insertInto('subscriptions').values({
        tenant_id: tenantId, plan_id: plan.id, plan_name: plan.name, price_cents: plan.price_cents, max_users: plan.max_users, max_units: plan.max_units,
        grace_days: graceDays, provider: this.provider.name, provider_customer_ref: ext.customerRef, provider_subscription_ref: ext.subscriptionRef, created_by: actorId,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, tenantId, { actorUserId: actorId, action: 'subscription.create', entityType: 'subscription', entityId: sub.id,
        data: { plan: plan.code, priceCents: plan.price_cents, graceDays } });
      await this.sync(tx, tenantId);
      return sub;
    });
  }

  /**
   * Cancela a assinatura. A empresa mantém acesso até o fim do período pago e
   * depois fica SOMENTE LEITURA: nenhum documento é apagado.
   */
  async cancel(actorId: string, tenantId: string, reason: string) {
    return this.db.run({ tenantId, userId: actorId }, async (tx) => {
      const sub = await tx.selectFrom('subscriptions').selectAll().where('status', '<>', 'CANCELED').forUpdate().executeTakeFirst();
      if (!sub) throw notFound('Assinatura');
      if (sub.provider_subscription_ref) await this.provider.cancelSubscription(sub.provider_subscription_ref);
      const row = await tx.updateTable('subscriptions').set({ status: 'CANCELED', canceled_at: new Date(), cancel_reason: reason })
        .where('id', '=', sub.id).returningAll().executeTakeFirstOrThrow();
      await audit(tx, tenantId, { actorUserId: actorId, action: 'subscription.cancel', entityType: 'subscription', entityId: sub.id, data: { reason } });
      await this.sync(tx, tenantId);
      return row;
    });
  }

  /** Processa um aviso do provedor: idempotente e sempre dentro da empresa certa. */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    let e: BillingEvent;
    try {
      e = event.parse(this.provider.parseWebhook(rawBody, headers));
    } catch {
      throw new BadRequestException({ code: 'INVALID_WEBHOOK', message: 'Aviso de pagamento inválido.' });
    }
    const tenantId = await this.db.run({}, async (tx) =>
      (await sql<{ t: string | null }>`SELECT billing_resolve_tenant(${this.provider.name}, ${e.subscriptionRef}) AS t`.execute(tx)).rows[0]?.t ?? null);
    if (!tenantId) {
      this.log.warn(`aviso para assinatura desconhecida (${e.type})`);
      return { accepted: false };
    }
    return this.db.run({ tenantId }, async (tx) => {
      const inserted = await tx.insertInto('billing_events').values({
        tenant_id: tenantId, provider: this.provider.name, event_id: e.eventId, type: e.type, data: JSON.stringify(e),
        body_sha256: createHash('sha256').update(rawBody).digest('hex'),
      }).onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing()).returning('id').executeTakeFirst();
      if (!inserted) return { accepted: true, duplicate: true };
      await this.apply(tx, tenantId, e);
      const status = await this.sync(tx, tenantId);
      return { accepted: true, tenantStatus: status };
    });
  }

  private async apply(tx: Tx, tenantId: string, e: BillingEvent) {
    const sub = await tx.selectFrom('subscriptions').selectAll().where('provider', '=', this.provider.name)
      .where('provider_subscription_ref', '=', e.subscriptionRef).forUpdate().executeTakeFirstOrThrow();
    const findCharge = () => tx.selectFrom('invoices').selectAll().where('provider', '=', this.provider.name)
      .where('provider_charge_ref', '=', e.chargeRef!).forUpdate().executeTakeFirst();
    const need = (cond: unknown) => {
      if (!cond) throw new BadRequestException({ code: 'INVALID_WEBHOOK', message: 'Aviso de pagamento incompleto.' });
    };
    switch (e.type) {
      case 'charge.created': {
        need(e.chargeRef && e.amountCents && e.dueDate);
        if (await findCharge()) return;
        await tx.insertInto('invoices').values({
          tenant_id: tenantId, subscription_id: sub.id, amount_cents: e.amountCents!, due_date: e.dueDate!,
          provider: this.provider.name, provider_charge_ref: e.chargeRef!,
        }).execute();
        return;
      }
      case 'charge.paid': {
        need(e.chargeRef);
        const inv = await findCharge();
        need(inv);
        if (inv!.status !== 'PAID' && inv!.status !== 'VOID') {
          await tx.updateTable('invoices').set({ status: 'PAID', paid_at: e.paidAt ? new Date(e.paidAt) : new Date(), receipt_url: e.receiptUrl ?? null, failure_reason: null })
            .where('id', '=', inv!.id).execute();
        }
        if (e.periodEnd && sub.status !== 'CANCELED') {
          await tx.updateTable('subscriptions').set({ current_period_end: e.periodEnd }).where('id', '=', sub.id).execute();
        }
        await audit(tx, tenantId, { actorUserId: null, action: 'invoice.paid', entityType: 'invoice', entityId: inv!.id });
        return;
      }
      case 'charge.failed': {
        need(e.chargeRef);
        const inv = await findCharge();
        need(inv);
        if (inv!.status === 'OPEN' || inv!.status === 'FAILED') {
          await tx.updateTable('invoices').set({ status: 'FAILED', failure_reason: e.failureReason ?? 'Pagamento recusado pelo provedor' }).where('id', '=', inv!.id).execute();
        }
        await audit(tx, tenantId, { actorUserId: null, action: 'invoice.failed', entityType: 'invoice', entityId: inv!.id, data: { reason: e.failureReason ?? null } });
        return;
      }
      case 'charge.voided': {
        need(e.chargeRef);
        const inv = await findCharge();
        need(inv);
        if (inv!.status === 'OPEN' || inv!.status === 'FAILED') await tx.updateTable('invoices').set({ status: 'VOID' }).where('id', '=', inv!.id).execute();
        return;
      }
      case 'subscription.canceled': {
        if (sub.status !== 'CANCELED') {
          await tx.updateTable('subscriptions').set({ status: 'CANCELED', canceled_at: new Date(), cancel_reason: 'Cancelada no provedor de pagamento' })
            .where('id', '=', sub.id).execute();
          await audit(tx, tenantId, { actorUserId: null, action: 'subscription.cancel', entityType: 'subscription', entityId: sub.id, data: { by: 'provider' } });
        }
        return;
      }
    }
  }
}
