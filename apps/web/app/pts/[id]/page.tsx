'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FUNCTION_LABEL, fmt, MEANING_LABEL, PT_STATUS } from '@/components/pt/labels';
import { ValidityBanner } from '@/components/pt/validity';
import { QuestionCard } from '@/components/question-card';
import { AppShell, useSession } from '@/components/session';
import { Banner, Button, Card, Field, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { reauthenticate } from '@/lib/auth';
import type { Pt, PtCheck, TeamFunction } from '@/lib/types';

const TABS = ['Dados', 'Checklist', 'Medições', 'Liberação', 'Assinaturas'] as const;
type Tab = (typeof TABS)[number];
const EDITABLE = ['DRAFT', 'AWAITING_CORRECTION'];

/** Mostra erro da API; quando a assinatura pede login recente, oferece entrar de novo. */
function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="flex flex-col gap-2">
      <Banner tone="danger" title={error.code === 'REAUTH_REQUIRED' ? 'Confirme sua identidade' : undefined}>
        {error.message}
        {error.blocking.length > 0 && <ul className="mt-1 list-disc pl-5">{error.blocking.map((b, i) => <li key={i}>{b.message}</li>)}</ul>}
      </Banner>
      {error.code === 'REAUTH_REQUIRED' && (
        <Button onClick={() => reauthenticate(window.location.pathname)}>Entrar de novo para assinar</Button>
      )}
    </div>
  );
}

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (path: string, method = 'POST', body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(path, method, body);
      onDone();
      return r;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', 'Não foi possível concluir.'));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function PtPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const [pt, setPt] = useState<Pt | null>(null);
  const [check, setCheck] = useState<PtCheck | null>(null);
  const [tab, setTab] = useState<Tab>('Dados');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api<Pt>(`/work-permits/${id}`), api<PtCheck>(`/work-permits/${id}/check`)]);
      setPt(p);
      setCheck(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar a PT.');
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger">{error}</Banner>;
  if (!pt || !check) return <p className="text-muted" aria-busy="true">Carregando…</p>;

  const myTeam = pt.team.filter((m) => m.userId === session.me.user.id);
  const canSuspend = (pt.status === 'RELEASED' || pt.status === 'IN_EXECUTION') && (myTeam.length > 0 || session.can('pt.field')(pt.unit_id));
  const editable = EDITABLE.includes(pt.status) && session.can('pt.write')(pt.unit_id);

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold">{pt.number}</h1>
        <p className="text-muted">{pt.type.name} · APR {pt.apr.number}{pt.apr.revision ? ` rev. ${pt.apr.revision}` : ''}</p>
        <p className="text-muted">{pt.location} · {fmt(pt.starts_at)} até {fmt(pt.ends_at)}</p>
      </div>
      <ValidityBanner pt={pt} />
      {canSuspend && <SuspendBar ptId={pt.id} onDone={load} />}

      <nav role="tablist" aria-label="Partes da PT" className="flex gap-1 overflow-x-auto rounded-lg bg-gray-200 p-1">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`min-h-[48px] shrink-0 rounded-md px-3 text-[0.95rem] font-semibold ${tab === t ? 'bg-surface shadow' : ''}`}>{t}</button>
        ))}
      </nav>

      <div role="tabpanel" aria-label={tab} className="flex flex-col gap-4">
        {tab === 'Dados' && <DataTab pt={pt} editable={editable} onDone={load} />}
        {tab === 'Checklist' && pt.questions.map((q) => (
          <QuestionCard key={q.id} basePath={`/work-permits/${pt.id}`} question={q} total={pt.questions.length} editable={editable}
            answer={pt.answers.find((a) => a.questionId === q.id)} userId={session.me.user.id} onChange={load} />
        ))}
        {tab === 'Medições' && <MeasurementsTab pt={pt} onDone={load} />}
        {tab === 'Liberação' && <FlowTab pt={pt} check={check} onDone={load} goTo={setTab} />}
        {tab === 'Assinaturas' && <SignaturesTab pt={pt} />}
      </div>
    </>
  );
}

/** Suspender fica sempre à mão. Parar é sempre o lado seguro. */
function SuspendBar({ ptId, onDone }: { ptId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction(() => {
    setOpen(false);
    onDone();
  });
  return (
    <div className="sticky top-[68px] z-[6] -mx-4 bg-canvas px-4 py-2">
      {!open ? (
        <Button variant="danger" className="w-full" onClick={() => setOpen(true)}>Suspender PT</Button>
      ) : (
        <Card>
          <div className="flex flex-col gap-3">
            <Field label="Por que suspender?" required multiline value={reason} onChange={setReason} hint="Ex.: mudança de condição, chuva, alarme do detector." />
            <ActionError error={error} />
            <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => run(`/work-permits/${ptId}/suspend`, 'POST', { reason })}>Confirmar suspensão</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>Voltar</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

interface Worker { id: string; full_name: string; user_id: string | null; active: boolean }

function DataTab({ pt, editable, onDone }: { pt: Pt; editable: boolean; onDone: () => void }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [members, setMembers] = useState(pt.team.map((m) => ({ workerId: m.workerId, function: m.function })));
  const [add, setAdd] = useState<{ workerId: string; function: TeamFunction | '' }>({ workerId: '', function: '' });
  const { busy, error, run } = useAction(onDone);

  useEffect(() => {
    if (editable) api<Worker[]>('/workers').then((w) => setWorkers(w.filter((x) => x.active))).catch(() => undefined);
  }, [editable]);

  const name = (wid: string) => workers.find((w) => w.id === wid)?.full_name ?? pt.team.find((m) => m.workerId === wid)?.name ?? '—';
  return (
    <>
      <Card>
        <h2 className="text-lg font-bold">Atividade</h2>
        <p className="mt-1">{pt.description}</p>
        <p className="mt-2 text-sm text-muted">Funções exigidas: {pt.type.requirements.filter((r) => r.minCount > 0).map((r) => `${FUNCTION_LABEL[r.function]} (${r.minCount})`).join(', ') || 'nenhuma'}</p>
      </Card>
      <Card>
        <h2 className="text-lg font-bold">Equipe</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {members.length === 0 && <li className="text-muted">Nenhuma pessoa incluída.</li>}
          {members.map((m, i) => (
            <li key={`${m.workerId}-${m.function}`} className="flex min-h-[52px] items-center justify-between gap-2 rounded-lg bg-gray-50 px-3">
              <span><strong>{name(m.workerId)}</strong> · {FUNCTION_LABEL[m.function]}
                {!editable && pt.team.find((t) => t.workerId === m.workerId && t.function === m.function)?.acknowledged && <span className="ml-2 text-sm font-bold text-ok">ciência registrada</span>}
              </span>
              {editable && <Button variant="ghost" onClick={() => setMembers(members.filter((_, j) => j !== i))}>Remover</Button>}
            </li>
          ))}
        </ul>
        {editable && (
          <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
            <Select label="Pessoa" value={add.workerId} onChange={(v) => setAdd({ ...add, workerId: v })}
              options={workers.map((w) => ({ value: w.id, label: `${w.full_name}${w.user_id ? '' : ' (sem acesso ao sistema)'}` }))} />
            <Select label="Função" value={add.function} onChange={(v) => setAdd({ ...add, function: v as TeamFunction })}
              options={Object.entries(FUNCTION_LABEL).map(([value, label]) => ({ value, label }))} />
            <Button variant="secondary" disabled={!add.workerId || !add.function}
              onClick={() => { setMembers([...members, { workerId: add.workerId, function: add.function as TeamFunction }]); setAdd({ workerId: '', function: '' }); }}>
              Incluir na equipe
            </Button>
            <ActionError error={error} />
            <Button disabled={busy} onClick={() => run(`/work-permits/${pt.id}/team`, 'PUT', { rowVersion: pt.row_version, members })}>Salvar equipe</Button>
          </div>
        )}
      </Card>
    </>
  );
}

/** Aceita vírgula ou ponto decimal, como se escreve no Brasil. */
const toNumber = (v: string) => (/^-?\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(',', '.')) : NaN);

function MeasurementsTab({ pt, onDone }: { pt: Pt; onDone: () => void }) {
  const session = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [instrument, setInstrument] = useState('');
  const { busy, error, run } = useAction(onDone);
  const [last, setLast] = useState<string | null>(null);
  const canMeasure = ['AWAITING_APPROVAL', 'RELEASED', 'IN_EXECUTION', 'SUSPENDED'].includes(pt.status) && session.can('pt.field')(pt.unit_id);

  if (!pt.type.requiresGasMonitoring) return <Card><p>Este tipo de PT não exige monitoramento atmosférico.</p></Card>;
  const limits = (p: Pt['type']['gasParameters'][number]) =>
    [p.min !== undefined ? `mín. ${p.min}` : null, p.max !== undefined ? `máx. ${p.max}` : null].filter(Boolean).join(' · ') + ` ${p.unit}`;

  return (
    <>
      <Card>
        <h2 className="text-lg font-bold">Registrar medição</h2>
        <p className="text-sm text-muted">Medições valem por {pt.type.gasMaxAgeMinutes} min. Fora do limite com a PT em vigor, ela é suspensa na hora.</p>
        {canMeasure ? (
          <div className="mt-3 flex flex-col gap-3">
            <Field label="Instrumento (modelo e nº de série)" required value={instrument} onChange={setInstrument} />
            {pt.type.gasParameters.map((p) => (
              <Field key={p.key} label={`${p.label} (${p.unit})`} hint={`Limites: ${limits(p)}`} inputMode="decimal" value={values[p.key] ?? ''}
                error={values[p.key] && Number.isNaN(toNumber(values[p.key]!)) ? 'Digite só o número, ex.: 20,9' : undefined}
                onChange={(v) => setValues({ ...values, [p.key]: v })} />
            ))}
            <ActionError error={error} />
            {last && <Banner tone={last.startsWith('Atenção') ? 'danger' : 'ok'}>{last}</Banner>}
            <Button disabled={busy || !instrument.trim() || pt.type.gasParameters.every((p) => !values[p.key])
              || Object.values(values).some((v) => v && Number.isNaN(toNumber(v)))} onClick={async () => {
              let suspended = false;
              let out = 0;
              for (const p of pt.type.gasParameters) {
                const v = values[p.key];
                if (!v) continue;
                const r = await run(`/work-permits/${pt.id}/measurements`, 'POST', { parameterKey: p.key, value: toNumber(v), instrument }) as { within_limits: boolean; suspended: boolean } | null;
                if (!r) return;
                if (!r.within_limits) out++;
                suspended ||= r.suspended;
              }
              setValues({});
              setLast(out ? `Atenção: ${out} medição(ões) fora do limite.${suspended ? ' A PT foi suspensa.' : ''}` : 'Medições registradas dentro dos limites.');
            }}>Registrar medições</Button>
          </div>
        ) : <p className="mt-2 text-muted">Medições não podem ser registradas nesta situação ou com o seu perfil.</p>}
      </Card>
      <Card>
        <h2 className="text-lg font-bold">Histórico</h2>
        {pt.measurements.length === 0 ? <p className="text-muted">Nenhuma medição.</p> : (
          <ul className="mt-2 flex flex-col gap-2">
            {[...pt.measurements].reverse().map((m) => {
              const p = pt.type.gasParameters.find((x) => x.key === m.parameterKey);
              return (
                <li key={m.id} className={`rounded-lg px-3 py-2 ${m.withinLimits ? 'bg-gray-50' : 'bg-danger-bg text-danger'}`}>
                  <strong>{p?.label ?? m.parameterKey}: {m.value} {m.unit}</strong> · {m.withinLimits ? 'dentro do limite' : 'FORA DO LIMITE'}
                  <span className="block text-sm">{fmt(m.receivedAt)} · {m.instrument}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function FlowTab({ pt, check, onDone, goTo }: { pt: Pt; check: PtCheck; onDone: () => void; goTo: (t: Tab) => void }) {
  const session = useSession();
  const me = session.me.user.id;
  const { busy, error, run } = useAction(onDone);
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState({ areaReleased: false, teamOut: false, notes: '' });
  const can = (p: Parameters<typeof session.can>[0]) => session.can(p)(pt.unit_id);
  const mine = pt.team.filter((m) => m.userId === me);
  const pendingAck = mine.some((m) => !m.acknowledged);
  const inside = pt.entries.filter((e) => !e.exited_at);
  const target = (i: PtCheck['blocking'][number]): Tab => (i.questionId ? 'Checklist' : /GAS/.test(i.code) ? 'Medições' : 'Dados');

  return (
    <>
      {check.blocking.length > 0 && !['CLOSED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'IN_EXECUTION'].includes(pt.status) && (
        <Card>
          <h2 className="text-lg font-bold text-danger">Pendências ({check.blocking.length})</h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            {check.blocking.map((i, n) => (
              <li key={n}>{i.message} <button type="button" className="min-h-[44px] font-semibold text-brand-ink underline" onClick={() => goTo(target(i))}>Ir para {target(i).toLowerCase()}</button></li>
            ))}
          </ul>
        </Card>
      )}
      <ActionError error={error} />

      {EDITABLE.includes(pt.status) && can('pt.write') && (
        <Button disabled={busy || !check.ready} onClick={() => run(`/work-permits/${pt.id}/submit`)}>Enviar para análise</Button>
      )}

      {pt.status === 'IN_ANALYSIS' && can('pt.review') && pt.created_by !== me && (
        <Card>
          <h2 className="text-lg font-bold">Análise técnica</h2>
          <div className="mt-2 flex flex-col gap-3">
            <Field label="Observação" multiline value={note} onChange={setNote} hint="Obrigatória para devolver." />
            <Button disabled={busy || !check.ready} onClick={() => run(`/work-permits/${pt.id}/review`, 'POST', { approve: true, ...(note ? { note } : {}) })}>Enviar para aprovação</Button>
            <Button variant="secondary" disabled={busy || !note.trim()} onClick={() => run(`/work-permits/${pt.id}/review`, 'POST', { approve: false, note })}>Devolver para correção</Button>
          </div>
        </Card>
      )}

      {(pt.status === 'AWAITING_APPROVAL' || pt.status === 'SUSPENDED') && can('pt.release') && (
        <Card>
          <h2 className="text-lg font-bold">{pt.status === 'SUSPENDED' ? 'Retomar a PT' : 'Liberar a PT'}</h2>
          <p className="text-muted">Confira as condições no local. A liberação é assinada em seu nome, com verificação em duas etapas e login recente.</p>
          <Button className="mt-3 w-full" disabled={busy} onClick={() => run(`/work-permits/${pt.id}/${pt.status === 'SUSPENDED' ? 'resume' : 'release'}`)}>
            {pt.status === 'SUSPENDED' ? 'Assinar retomada' : 'Assinar liberação'}
          </Button>
        </Card>
      )}

      {pt.status === 'RELEASED' && mine.length > 0 && (
        <Card>
          <h2 className="text-lg font-bold">Ciência dos riscos</h2>
          {pendingAck ? (
            <>
              <p>Li a APR e a PT, conheço os riscos e as medidas de controle desta atividade.</p>
              <Button className="mt-3 w-full" disabled={busy} onClick={() => run(`/work-permits/${pt.id}/acknowledge`)}>Assinar ciência</Button>
            </>
          ) : <p className="font-semibold text-ok">Sua ciência está registrada.</p>}
        </Card>
      )}

      {pt.status === 'RELEASED' && (
        <Card>
          <h2 className="text-lg font-bold">Ciência da equipe</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {pt.team.map((m) => (
              <li key={m.id}>{m.name} · {FUNCTION_LABEL[m.function]} — <strong className={m.acknowledged ? 'text-ok' : 'text-danger'}>{m.acknowledged ? 'registrada' : 'pendente'}</strong></li>
            ))}
          </ul>
          {can('pt.field') && <Button className="mt-3 w-full" disabled={busy || pt.team.some((m) => !m.acknowledged)} onClick={() => run(`/work-permits/${pt.id}/start`)}>Iniciar execução</Button>}
        </Card>
      )}

      {pt.type.requiresEntryLog && ['IN_EXECUTION', 'SUSPENDED', 'EXPIRED', 'RELEASED'].includes(pt.status) && (
        <Card>
          <h2 className="text-lg font-bold">Entradas e saídas</h2>
          <p className={`mt-1 text-xl font-black ${inside.length ? 'text-danger' : 'text-ok'}`}>{inside.length} pessoa(s) dentro</p>
          <ul className="mt-2 flex flex-col gap-2">
            {[...new Map(pt.team.map((m) => [m.workerId, m])).values()].map((m) => {
              const open = inside.find((e) => e.worker_id === m.workerId);
              return (
                <li key={m.workerId} className="flex min-h-[56px] items-center justify-between gap-2 rounded-lg bg-gray-50 px-3">
                  <span><strong>{m.name}</strong>{open ? <span className="block text-sm text-danger">dentro desde {fmt(open.entered_at)}</span> : null}</span>
                  {open ? (
                    <Button variant="secondary" disabled={busy} onClick={() => run(`/work-permits/${pt.id}/entries/${open.id}/exit`)}>Registrar saída</Button>
                  ) : pt.status === 'IN_EXECUTION' && pt.validity.valid && can('pt.field') ? (
                    <Button variant="secondary" disabled={busy} onClick={() => run(`/work-permits/${pt.id}/entries`, 'POST', { workerId: m.workerId })}>Registrar entrada</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {['IN_EXECUTION', 'SUSPENDED', 'EXPIRED'].includes(pt.status) && (can('pt.release') || mine.some((m) => m.function === 'RESPONSIBLE')) && (
        <Card>
          <h2 className="text-lg font-bold">Encerrar a PT</h2>
          <div className="mt-2 flex flex-col gap-3">
            {[['areaReleased', 'Área inspecionada e liberada'], ['teamOut', 'Toda a equipe saiu do local']].map(([k, label]) => (
              <label key={k} className="flex min-h-[48px] items-center gap-3 font-semibold">
                <input type="checkbox" className="h-6 w-6" checked={closing[k as 'areaReleased']} onChange={(e) => setClosing({ ...closing, [k!]: e.target.checked })} />
                {label}
              </label>
            ))}
            <Field label="Observações" multiline value={closing.notes} onChange={(v) => setClosing({ ...closing, notes: v })} />
            <Button disabled={busy || !closing.areaReleased || !closing.teamOut || inside.length > 0}
              onClick={() => run(`/work-permits/${pt.id}/close`, 'POST', { areaReleased: true, teamOut: true, ...(closing.notes ? { notes: closing.notes } : {}) })}>
              Assinar encerramento
            </Button>
            {inside.length > 0 && <p className="text-sm font-semibold text-danger">Registre a saída de todos antes de encerrar.</p>}
          </div>
        </Card>
      )}

      {['CLOSED', 'CANCELLED', 'REJECTED'].includes(pt.status) && <Banner tone="info" title={PT_STATUS[pt.status]}>Esta PT está finalizada.</Banner>}
    </>
  );
}

interface SigReport { unchangedSinceRelease: boolean | null; signatures: { id: string; meaning: string; signerName: string; signedAt: string; hash: string; integrity: boolean }[] }

function SignaturesTab({ pt }: { pt: Pt }) {
  const [r, setR] = useState<SigReport | null>(null);
  useEffect(() => {
    api<SigReport>(`/work-permits/${pt.id}/signatures`).then(setR).catch(() => undefined);
  }, [pt.id]);
  if (!r) return <p className="text-muted">Carregando…</p>;
  return (
    <>
      {r.unchangedSinceRelease !== null && (
        <Banner tone={r.unchangedSinceRelease ? 'ok' : 'danger'}>
          {r.unchangedSinceRelease ? 'O conteúdo da PT é o mesmo que foi assinado na última liberação.' : 'Atenção: o conteúdo da PT difere do que foi assinado na última liberação.'}
        </Banner>
      )}
      {r.signatures.length === 0 && <p className="text-muted">Nenhuma assinatura ainda.</p>}
      <ul className="flex flex-col gap-2">
        {r.signatures.map((s) => (
          <li key={s.id} className="rounded-lg bg-surface p-3 ring-1 ring-line">
            <strong>{MEANING_LABEL[s.meaning] ?? s.meaning}</strong> · {s.signerName}
            <span className="block text-sm text-muted">{fmt(s.signedAt)} · {s.integrity ? 'íntegra' : 'FALHA DE INTEGRIDADE'}</span>
            <code className="block break-all text-xs text-muted">{s.hash}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function Page() {
  return <AppShell><PtPage /></AppShell>;
}
