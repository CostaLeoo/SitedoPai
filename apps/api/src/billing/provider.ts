import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** Evento de cobrança já normalizado (independe do provedor). */
export interface BillingEvent {
  eventId: string;
  type: 'charge.created' | 'charge.paid' | 'charge.failed' | 'charge.voided' | 'subscription.canceled';
  subscriptionRef: string;
  chargeRef?: string;
  amountCents?: number;
  /** AAAA-MM-DD */
  dueDate?: string;
  paidAt?: string;
  failureReason?: string;
  receiptUrl?: string;
  /** AAAA-MM-DD: fim do período pago (quando o provedor informa). */
  periodEnd?: string;
}

/**
 * Integração com o provedor de pagamentos. O cartão (ou Pix/boleto) é
 * informado na página do provedor; a aplicação só guarda referências.
 */
export interface PaymentProvider {
  readonly name: string;
  createSubscription(input: { tenantId: string; cnpj: string; legalName: string; priceCents: number; planName: string }):
    Promise<{ customerRef: string; subscriptionRef: string }>;
  cancelSubscription(subscriptionRef: string): Promise<void>;
  /** Confere a autenticidade do aviso e devolve o evento normalizado. Lança erro se inválido. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): BillingEvent;
}
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Provedor SIMULADO, para desenvolvimento e testes. Webhooks assinados com
 * HMAC-SHA256 no formato `t=<unix>,v1=<hex>` sobre `${t}.${corpo}`, com
 * tolerância de 5 minutos (mesmo modelo usado por provedores reais).
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';
  constructor(private readonly secret: string, private readonly toleranceSeconds = 300) {
    if (secret.length < 24) throw new Error('BILLING_WEBHOOK_SECRET precisa de pelo menos 24 caracteres');
  }

  async createSubscription() {
    return { customerRef: `cus_${randomUUID()}`, subscriptionRef: `sub_${randomUUID()}` };
  }

  async cancelSubscription() {
    /* nada a fazer no simulado */
  }

  sign(body: string, at = Math.floor(Date.now() / 1000)) {
    return `t=${at},v1=${createHmac('sha256', this.secret).update(`${at}.${body}`).digest('hex')}`;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): BillingEvent {
    const sig = header(headers, 'x-signature') ?? '';
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=', 2) as [string, string]));
    const t = Number(parts.t);
    if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > this.toleranceSeconds) throw new Error('assinatura expirada ou ausente');
    const expected = createHmac('sha256', this.secret).update(`${t}.`).update(rawBody).digest();
    const got = Buffer.from(parts.v1 ?? '', 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('assinatura inválida');
    const e = JSON.parse(rawBody.toString('utf8')) as BillingEvent;
    if (typeof e.eventId !== 'string' || typeof e.subscriptionRef !== 'string' || typeof e.type !== 'string') throw new Error('evento malformado');
    return e;
  }
}
