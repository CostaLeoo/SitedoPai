'use client';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Clock3, KeyRound, PauseCircle, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PT_STATUS } from '@/components/pt/labels';
import { AppShell, useSession } from '@/components/session';
import { Banner, STATUS_LABEL } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { PtStatus } from '@/lib/types';

interface Dashboard {
  aprs: Record<string, number>;
  pts: Record<string, number>;
  ptsValidNow: number;
  attention: {
    aprs: { id: string; number: string; revision: number; status: string; location: string; service_description: string; updated_at: string }[];
    pts: { id: string; number: string; status: PtStatus; location: string; description: string; updated_at: string }[];
  };
  recent: { kind: 'apr' | 'pt'; id: string; number: string; status: string; location: string; updated_at: string }[];
}

const when = (d: string) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
type Tone = 'green' | 'amber' | 'red' | 'blue';
const PILL: Record<Tone, string> = { green: 'bg-ok-bg text-ok', amber: 'bg-warn-bg text-warn', red: 'bg-danger-bg text-danger', blue: 'bg-info-bg text-info' };
const ptTone = (s: string): Tone => (s === 'SUSPENDED' ? 'red' : s === 'RELEASED' || s === 'IN_EXECUTION' ? 'green' : s === 'AWAITING_CORRECTION' ? 'amber' : 'blue');
const aprTone = (s: string): Tone => (s === 'APPROVED' ? 'green' : s === 'RETURNED' ? 'amber' : s === 'CANCELLED' ? 'red' : 'blue');

function Stat({ label, value, hint, icon: Icon, tone }: { label: string; value: number; hint: string; icon: LucideIcon; tone: Tone }) {
  const color = { green: 'text-ok', amber: 'text-warn', red: 'text-danger', blue: 'text-info' }[tone];
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm sm:p-5">
      <div className="flex items-center justify-between gap-2 text-sm text-muted">
        <span>{label}</span>
        <Icon aria-hidden size={20} className={color} />
      </div>
      <strong className="mt-3 block text-3xl font-semibold tracking-tight sm:mt-4 sm:text-4xl">{value}</strong>
      <span className="mt-2 hidden text-sm text-muted sm:block">{hint}</span>
    </div>
  );
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs font-semibold ${PILL[tone]}`}>{children}</span>;
}

function Painel() {
  const { me, tenant } = useSession();
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Dashboard>('/dashboard').then(setD).catch((e: ApiError) => setError(e.message));
  }, []);
  const first = me.user.displayName.replace(/\(.*?\)/g, '').trim().split(' ')[0];
  const canWrite = tenant.roles.some((r) => ['SST', 'SUPERVISOR', 'EXECUTOR'].includes(r.role));
  const attention = d ? d.attention.aprs.length + d.attention.pts.length : 0;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="mb-2 block text-xs font-bold uppercase tracking-[0.15em] text-brand">Visão geral</span>
          <h1 className="text-3xl font-bold tracking-tight">Olá, {first}</h1>
          <p className="mt-1 text-muted">Situação das APRs e Permissões de Trabalho das suas unidades.</p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <a href="/aprs/nova" className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-brand px-5 font-semibold text-white hover:bg-brand-ink">
              <ClipboardCheck aria-hidden size={20} /> Nova APR
            </a>
            <a href="/pts/nova" className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-line bg-surface px-5 font-semibold hover:bg-canvas">
              <KeyRound aria-hidden size={20} /> Nova PT
            </a>
          </div>
        )}
      </div>

      {error && <Banner tone="danger">{error}</Banner>}
      {!d && !error && <p className="text-muted" aria-busy="true">Carregando…</p>}

      {d && (
        <>
          <section aria-label="Indicadores" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Stat label="PTs válidas agora" value={d.ptsValidNow} hint="Liberadas e dentro do prazo" icon={ShieldCheck} tone="green" />
            <Stat label="PTs suspensas" value={d.pts.SUSPENDED ?? 0} hint="Exigem nova medição e assinatura" icon={PauseCircle} tone="red" />
            <Stat label="APRs aguardando aprovação" value={d.aprs.IN_REVIEW ?? 0} hint="Aprovação por outra pessoa" icon={Clock3} tone="amber" />
            <Stat label="APRs aprovadas" value={d.aprs.APPROVED ?? 0} hint="Prontas para gerar PT" icon={CheckCircle2} tone="blue" />
          </section>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
            <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm" aria-labelledby="atencao">
              <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
                <div>
                  <h2 id="atencao" className="text-lg font-bold">Precisa de atenção</h2>
                  <p className="text-sm text-muted">APRs em revisão ou devolvidas e PTs em andamento que esperam alguém.</p>
                </div>
                {attention > 0 && <Pill tone="amber">{attention}</Pill>}
              </div>
              {attention === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-muted">
                  <CheckCircle2 aria-hidden size={32} className="text-ok" />
                  <p className="font-semibold text-ink">Nada pendente agora.</p>
                  <p className="text-sm">Quando uma APR ou PT depender de alguém, ela aparece aqui.</p>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {d.attention.pts.map((p) => (
                    <li key={p.id}>
                      <a href={`/pts/${p.id}`} className="flex items-center gap-3 px-5 py-4 hover:bg-canvas">
                        {p.status === 'SUSPENDED' ? <AlertTriangle aria-hidden size={20} className="shrink-0 text-danger" /> : <KeyRound aria-hidden size={20} className="shrink-0 text-info" />}
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">{p.number} · {p.location || 'Local não informado'}</span>
                          <span className="block truncate text-sm text-muted">{p.description || 'Sem descrição'}</span>
                        </span>
                        <Pill tone={ptTone(p.status)}>{PT_STATUS[p.status]}</Pill>
                        <ArrowRight aria-hidden size={18} className="hidden shrink-0 text-muted sm:block" />
                      </a>
                    </li>
                  ))}
                  {d.attention.aprs.map((a) => (
                    <li key={a.id}>
                      <a href={`/aprs/${a.id}`} className="flex items-center gap-3 px-5 py-4 hover:bg-canvas">
                        <ClipboardCheck aria-hidden size={20} className="shrink-0 text-warn" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">{a.number}{a.revision ? ` · rev. ${a.revision}` : ''} · {a.location || 'Local não informado'}</span>
                          <span className="block truncate text-sm text-muted">{a.service_description || 'Sem descrição'}</span>
                        </span>
                        <Pill tone={aprTone(a.status)}>{STATUS_LABEL[a.status] ?? a.status}</Pill>
                        <ArrowRight aria-hidden size={18} className="hidden shrink-0 text-muted sm:block" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <aside className="rounded-xl border border-[#d7e4d8] bg-[#f4f8f4] p-5" aria-labelledby="fluxo">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-ok-bg text-ok"><ShieldCheck aria-hidden size={22} /></span>
              <span className="block text-xs font-bold uppercase tracking-[0.15em] text-ok">Como funciona</span>
              <h2 id="fluxo" className="mt-1 text-xl font-bold leading-snug">Do risco à liberação, com responsáveis claros.</h2>
              <ol className="mt-4 space-y-3 text-sm">
                {['Preencha a APR em campo, com fotos.', 'Outra pessoa revisa e aprova.', 'A PT nasce da APR aprovada e é liberada com assinatura.', 'Mudou a condição? Qualquer integrante suspende.'].map((s, i) => (
                  <li key={s} className="flex gap-3">
                    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok-bg text-xs font-bold text-ok">{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </aside>
          </div>

          <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm" aria-labelledby="recentes">
            <div className="border-b border-line px-5 py-4">
              <h2 id="recentes" className="text-lg font-bold">Atividade recente</h2>
              <p className="text-sm text-muted">Últimas APRs e PTs alteradas.</p>
            </div>
            {d.recent.length === 0 ? (
              <p className="px-5 py-8 text-center text-muted">Nenhuma APR ou PT ainda. Comece por “Nova APR”.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[#fafcfc] text-xs uppercase tracking-wide text-muted">
                    <tr><th scope="col" className="px-5 py-3 font-semibold">Documento</th><th scope="col" className="px-5 py-3 font-semibold">Local</th><th scope="col" className="px-5 py-3 font-semibold">Situação</th><th scope="col" className="px-5 py-3 font-semibold">Atualizado</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.recent.map((r) => (
                      <tr key={`${r.kind}-${r.id}`}>
                        <td className="px-5 py-3"><a className="font-semibold underline-offset-4 hover:underline" href={`/${r.kind === 'apr' ? 'aprs' : 'pts'}/${r.id}`}>{r.number}</a><span className="block text-xs text-muted">{r.kind === 'apr' ? 'APR' : 'Permissão de Trabalho'}</span></td>
                        <td className="px-5 py-3">{r.location || '—'}</td>
                        <td className="px-5 py-3"><Pill tone={r.kind === 'apr' ? aprTone(r.status) : ptTone(r.status)}>{r.kind === 'apr' ? STATUS_LABEL[r.status] ?? r.status : PT_STATUS[r.status as PtStatus]}</Pill></td>
                        <td className="whitespace-nowrap px-5 py-3 text-muted">{when(r.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

export default function Page() {
  return <AppShell wide><Painel /></AppShell>;
}
