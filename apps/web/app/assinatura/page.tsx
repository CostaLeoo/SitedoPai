'use client';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/session';
import { Banner, Button, Card } from '@/components/ui';
import { api, ApiError, downloadExport } from '@/lib/api';
import { brl, date, INVOICE_STATUS, SUB_STATUS, TENANT_STATUS } from '@/lib/money';

interface Billing {
  tenantStatus: string;
  subscription: { plan_name: string; price_cents: number; max_users: number | null; max_units: number | null; status: string; grace_days: number; current_period_end: string | null; canceled_at: string | null } | null;
  invoices: { id: string; amount_cents: number; due_date: string; status: string; paid_at: string | null; failure_reason: string | null; receipt_url: string | null }[];
  usage: { activeUsers: number; units: number };
}

function Conta() {
  const [b, setB] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Billing>('/billing').then(setB).catch((e: ApiError) => setError(e.message));
  }, []);

  async function exportAll() {
    setBusy(true);
    setError(null);
    try {
      await downloadExport();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível gerar a exportação.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold">Conta da empresa</h1>
      {error && <Banner tone="danger">{error}</Banner>}
      {b && (
        <Card>
          <h2 className="text-lg font-bold">Assinatura</h2>
          <p className="mt-1">Situação da conta: <strong>{TENANT_STATUS[b.tenantStatus] ?? b.tenantStatus}</strong></p>
          {b.subscription ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">Plano</dt><dd className="font-semibold">{b.subscription.plan_name}</dd>
              <dt className="text-muted">Mensalidade</dt><dd>{brl(b.subscription.price_cents)}</dd>
              <dt className="text-muted">Pagamento</dt><dd>{SUB_STATUS[b.subscription.status]}</dd>
              <dt className="text-muted">Usuários</dt><dd>{b.usage.activeUsers}{b.subscription.max_users ? ` de ${b.subscription.max_users}` : ''}</dd>
              <dt className="text-muted">Unidades</dt><dd>{b.usage.units}{b.subscription.max_units ? ` de ${b.subscription.max_units}` : ''}</dd>
              <dt className="text-muted">Tolerância</dt><dd>{b.subscription.grace_days} dia(s) após o vencimento</dd>
              {b.subscription.canceled_at && <><dt className="text-muted">Cancelada em</dt><dd>{date(b.subscription.canceled_at)}</dd></>}
            </dl>
          ) : <p className="mt-2 text-muted">Sem assinatura cadastrada.</p>}
          <p className="mt-3 text-sm text-muted">O pagamento é feito na página do provedor. Nenhum dado de cartão fica no Vigia.</p>
        </Card>
      )}
      {b && b.invoices.length > 0 && (
        <Card>
          <h2 className="text-lg font-bold">Cobranças</h2>
          <ul className="mt-2 divide-y divide-line">
            {b.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="font-semibold">{brl(i.amount_cents)} · vence {date(i.due_date)}</p>
                  <p className="text-sm text-muted">{INVOICE_STATUS[i.status]}{i.paid_at ? ` em ${date(i.paid_at)}` : ''}{i.failure_reason ? ` — ${i.failure_reason}` : ''}</p>
                </div>
                {i.receipt_url && <a className="min-h-[44px] content-center underline" href={i.receipt_url} target="_blank" rel="noreferrer">Comprovante</a>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <h2 className="text-lg font-bold">Exportar todos os dados</h2>
        <p className="mt-1 text-muted">
          Um arquivo ZIP com APRs, PTs, assinaturas, auditoria, todos os PDFs emitidos e as fotos originais, além de um manifesto com o hash de cada arquivo.
          Funciona mesmo com a conta em modo somente consulta ou encerrada. Nada é apagado.
        </p>
        <Button className="mt-4 w-full sm:w-auto" disabled={busy} onClick={exportAll}>{busy ? 'Gerando o arquivo…' : 'Exportar dados (ZIP)'}</Button>
      </Card>
    </>
  );
}

export default function Page() {
  return <AppShell><Conta /></AppShell>;
}
