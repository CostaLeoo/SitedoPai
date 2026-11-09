'use client';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, useId } from 'react';
import { Banner, Button, Card } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { currentUser, logout } from '@/lib/auth';
import { brl, INVOICE_STATUS, SUB_STATUS, TENANT_STATUS, date } from '@/lib/money';
import type { Me } from '@/lib/types';

interface Plan { id: string; code: string; name: string; priceCents: number; maxUsers: number | null; maxUnits: number | null; active: boolean }
interface Row {
  tenant_id: string; legal_name: string; trade_name: string | null; cnpj: string; tenant_status: string;
  subscription_id: string | null; plan_name: string | null; price_cents: number | null; subscription_status: string | null; grace_days: number | null;
  overdue_cents: string; active_users: string; units: string; aprs: string; work_permits: string;
}
interface Invoice { id: string; amount_cents: number; due_date: string; status: string; provider_charge_ref: string }

const INPUT = 'w-full rounded-lg border-2 border-line bg-surface px-3 py-3 text-[1.0625rem]';
/** Campos não controlados (formulários curtos do painel). */
function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">{label}{props.required && <span className="text-danger"> *</span>}</label>
      <input id={id} className={INPUT} {...props} />
    </div>
  );
}
function Select({ label, children, ...props }: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">{label}{props.required && <span className="text-danger"> *</span>}</label>
      <select id={id} className={INPUT} {...props}>{children}</select>
    </div>
  );
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const intOrNull = (v: FormDataEntryValue | null) => (v && String(v).trim() ? Number(v) : null);

/**
 * Painel comercial da plataforma. Só dados de contrato e contagens de uso:
 * nenhum conteúdo de APR ou PT aparece aqui.
 */
export default function Plataforma() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([api<Row[]>('/platform/billing/overview'), api<Plan[]>('/platform/plans')]);
    setRows(o);
    setPlans(p);
  }, []);

  useEffect(() => {
    (async () => {
      if (!(await currentUser())) return router.replace('/entrar');
      const me = await api<Me>('/me');
      if (!me.platformAdmin) return router.replace('/aprs');
      await load();
      setReady(true);
    })().catch((e: ApiError) => setMsg({ tone: 'danger', text: e.message }));
  }, [router, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: ok });
      await load();
      if (open) setInvoices((await api<{ invoices: Invoice[] }>(`/platform/tenants/${open}/billing`)).invoices);
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Não foi possível concluir.' });
    }
  }

  async function toggle(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    setInvoices((await api<{ invoices: Invoice[] }>(`/platform/tenants/${id}/billing`)).invoices);
  }

  if (!ready) return <main className="mx-auto max-w-screen-md p-4">{msg ? <Banner tone="danger">{msg.text}</Banner> : <p className="text-muted">Carregando…</p>}</main>;

  return (
    <>
      <header className="sticky top-0 z-10 bg-ink text-white">
        <div className="mx-auto flex max-w-screen-md items-center justify-between px-4 py-3">
          <span className="font-bold">SitedoPai · Plataforma</span>
          <button type="button" className="min-h-[44px] px-2 underline underline-offset-4" onClick={() => logout()}>Sair</button>
        </div>
      </header>
      <main className="mx-auto flex max-w-screen-md flex-col gap-4 p-4 pb-24">
        <h1 className="text-2xl font-bold">Empresas e assinaturas</h1>
        <p className="text-muted">Dados comerciais e contagens de uso. O conteúdo das APRs e PTs dos clientes não é acessível aqui.</p>
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        {rows.map((r) => (
          <Card key={r.tenant_id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold">{r.trade_name ?? r.legal_name}</h2>
                <p className="text-sm text-muted">{r.legal_name} · CNPJ {r.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")}</p>
              </div>
              <span className="rounded-full bg-gray-200 px-3 py-1 text-sm font-bold">{TENANT_STATUS[r.tenant_status]}</span>
            </div>
            <p className="mt-2 text-sm">
              {r.plan_name ? `${r.plan_name} · ${brl(r.price_cents!)} · ${SUB_STATUS[r.subscription_status!]} · tolerância ${r.grace_days} dia(s)` : 'Sem assinatura'}
              {Number(r.overdue_cents) > 0 && <strong className="text-danger"> · em atraso {brl(Number(r.overdue_cents))}</strong>}
            </p>
            <p className="text-sm text-muted">Usuários ativos {r.active_users} · unidades {r.units} · APRs {r.aprs} · PTs {r.work_permits}</p>
            <Button variant="secondary" className="mt-3" onClick={() => toggle(r.tenant_id)} aria-expanded={open === r.tenant_id}>
              {open === r.tenant_id ? 'Fechar' : 'Gerenciar'}
            </Button>
            {open === r.tenant_id && (
              <div className="mt-4 flex flex-col gap-5 border-t border-line pt-4">
                {(!r.subscription_id || r.subscription_status === 'CANCELED') && (
                  <form className="flex flex-col gap-3" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    act(() => api(`/platform/tenants/${r.tenant_id}/subscription`, 'POST', { planId: f.get('planId'), graceDays: Number(f.get('graceDays')) }), 'Plano contratado.');
                  }}>
                    <h3 className="font-bold">Contratar plano</h3>
                    <Select label="Plano" name="planId" required>
                      {plans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {brl(p.priceCents)}</option>)}
                    </Select>
                    <Field label="Dias de tolerância após o vencimento" name="graceDays" inputMode="numeric" required pattern="[0-9]{1,2}" />
                    <Button type="submit">Contratar</Button>
                  </form>
                )}
                {r.subscription_id && r.subscription_status !== 'CANCELED' && (
                  <form className="flex flex-col gap-3" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    act(() => api(`/platform/tenants/${r.tenant_id}/subscription/cancel`, 'POST', { reason: f.get('reason') }), 'Assinatura cancelada. Nenhum documento foi apagado.');
                  }}>
                    <h3 className="font-bold">Cancelar assinatura</h3>
                    <Field label="Motivo" name="reason" required minLength={5} />
                    <Button type="submit" variant="danger">Cancelar assinatura</Button>
                  </form>
                )}
                <form className="flex flex-col gap-3" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  act(() => api(`/platform/tenants/${r.tenant_id}/status`, 'POST', { status: f.get('status'), reason: f.get('reason') }), 'Situação alterada.');
                }}>
                  <h3 className="font-bold">Alterar situação manualmente</h3>
                  <Select label="Nova situação" name="status" required>
                    <option value="ACTIVE">Ativa</option>
                    <option value="READ_ONLY">Somente consulta</option>
                    <option value="CLOSED">Encerrada (nada é apagado)</option>
                  </Select>
                  <Field label="Motivo" name="reason" required minLength={5} />
                  <Button type="submit" variant="secondary">Alterar situação</Button>
                </form>
                {r.subscription_id && r.subscription_status !== 'CANCELED' && (
                  <form className="flex flex-col gap-3" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    act(() => api('/platform/billing/simulate', 'POST', { tenantId: r.tenant_id, type: 'charge.created', dueDate: f.get('dueDate') }), 'Cobrança simulada criada.');
                  }}>
                    <h3 className="font-bold">Simulação de cobrança (provedor de teste)</h3>
                    <Field label="Vencimento" name="dueDate" type="date" defaultValue={today()} required />
                    <Button type="submit" variant="secondary">Gerar cobrança simulada</Button>
                  </form>
                )}
                {invoices.length > 0 && (
                  <div>
                    <h3 className="font-bold">Cobranças</h3>
                    <ul className="divide-y divide-line">
                      {invoices.map((i) => (
                        <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <span>{brl(i.amount_cents)} · vence {date(i.due_date)} · {INVOICE_STATUS[i.status]}</span>
                          {(i.status === 'OPEN' || i.status === 'FAILED') && (
                            <span className="flex gap-2">
                              <Button variant="secondary" onClick={() => act(() => api('/platform/billing/simulate', 'POST', { tenantId: r.tenant_id, type: 'charge.paid', chargeRef: i.provider_charge_ref }), 'Pagamento simulado.')}>Simular pagamento</Button>
                              <Button variant="ghost" onClick={() => act(() => api('/platform/billing/simulate', 'POST', { tenantId: r.tenant_id, type: 'charge.failed', chargeRef: i.provider_charge_ref }), 'Falha simulada.')}>Simular falha</Button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}

        <Card>
          <h2 className="text-lg font-bold">Nova empresa</h2>
          <form className="mt-3 flex flex-col gap-3" onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            act(() => api('/platform/tenants', 'POST', {
              legalName: f.get('legalName'), tradeName: String(f.get('tradeName') ?? '') || undefined, cnpj: f.get('cnpj'),
              admin: { email: f.get('email'), displayName: f.get('displayName') },
            }).then(() => form.reset()), 'Empresa cadastrada e administrador convidado.');
          }}>
            <Field label="Razão social" name="legalName" required />
            <Field label="Nome fantasia (opcional)" name="tradeName" />
            <Field label="CNPJ" name="cnpj" inputMode="numeric" required />
            <Field label="E-mail do administrador da empresa" name="email" type="email" required />
            <Field label="Nome do administrador" name="displayName" required />
            <Button type="submit">Cadastrar empresa</Button>
          </form>
        </Card>

        <Card>
          <h2 className="text-lg font-bold">Planos</h2>
          <ul className="mt-2 divide-y divide-line">
            {plans.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="font-semibold">{p.name} · {brl(p.priceCents)}/mês</p>
                  <p className="text-sm text-muted">{p.maxUsers ? `${p.maxUsers} usuários` : 'Usuários sem limite'} · {p.maxUnits ? `${p.maxUnits} unidades` : 'Unidades sem limite'}{p.active ? '' : ' · inativo'}</p>
                </div>
                <Button variant="secondary" onClick={() => act(() => api(`/platform/plans/${p.id}`, 'PATCH', { active: !p.active }), p.active ? 'Plano desativado.' : 'Plano ativado.')}>
                  {p.active ? 'Desativar' : 'Ativar'}
                </Button>
              </li>
            ))}
          </ul>
          <form className="mt-4 flex flex-col gap-3 border-t border-line pt-4" onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            const price = Math.round(Number(String(f.get('price')).replace(/\./g, '').replace(',', '.')) * 100);
            act(() => api('/platform/plans', 'POST', {
              code: f.get('code'), name: f.get('name'), priceCents: price, maxUsers: intOrNull(f.get('maxUsers')), maxUnits: intOrNull(f.get('maxUnits')),
            }).then(() => form.reset()), 'Plano criado.');
          }}>
            <h3 className="font-bold">Novo plano</h3>
            <Field label="Código (ex.: basico)" name="code" required pattern="[a-z0-9\-]{2,40}" />
            <Field label="Nome do plano" name="name" required />
            <Field label="Mensalidade (R$)" name="price" inputMode="decimal" required />
            <Field label="Máximo de usuários (vazio = sem limite)" name="maxUsers" inputMode="numeric" />
            <Field label="Máximo de unidades (vazio = sem limite)" name="maxUnits" inputMode="numeric" />
            <Button type="submit">Criar plano</Button>
          </form>
          <p className="mt-3 text-sm text-muted">Preço e limites de um plano não mudam depois de criado: cada assinatura guarda as condições contratadas.</p>
        </Card>
      </main>
    </>
  );
}
