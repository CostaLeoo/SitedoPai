'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnalysisEditor } from '@/components/analysis-editor';
import { QuestionCard } from '@/components/question-card';
import { AppShell, useSession } from '@/components/session';
import { Banner, Button, Card, Field, StatusBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { Apr, Check } from '@/lib/types';

const TABS = ['Dados', 'Checklist', 'Riscos', 'Enviar'] as const;
type Tab = (typeof TABS)[number];

function Editor() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const [apr, setApr] = useState<Apr | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [tab, setTab] = useState<Tab>('Dados');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([api<Apr>(`/aprs/${id}`), api<Check>(`/aprs/${id}/check`)]);
      setApr(a);
      setCheck(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar a APR.');
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="danger" title="Erro">{error}</Banner>;
  if (!apr || !check) return <p className="text-muted" aria-busy="true">Carregando…</p>;

  const editable = (apr.status === 'DRAFT' || apr.status === 'RETURNED') && session.can('apr.write')(apr.unitId);
  const answered = check.progress.answered;
  const total = check.progress.total;
  const pct = total ? Math.round((answered / total) * 100) : 0;

  return (
    <>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{apr.number}{apr.revision > 0 ? ` · rev. ${apr.revision}` : ''}</h1>
          <StatusBadge status={apr.status} />
        </div>
        <p className="text-muted">{apr.template.name} · modelo v{apr.template.version}</p>
      </div>

      {apr.status === 'RETURNED' && apr.decisionNote && <Banner tone="warn" title="Devolvida para correção">{apr.decisionNote}</Banner>}
      {apr.status === 'APPROVED' && <Banner tone="ok" title="APR aprovada">Esta APR não pode mais ser alterada. Mudanças exigem uma revisão.</Banner>}
      {apr.status === 'CANCELLED' && <Banner tone="info" title="APR cancelada">{apr.decisionNote}</Banner>}

      <div>
        <div className="flex justify-between text-sm font-semibold">
          <span>Checklist: {answered} de {total} respondidas</span>
          <span>{check.blocking.length} pendência(s)</span>
        </div>
        <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-gray-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso do checklist">
          <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <nav role="tablist" aria-label="Partes da APR" className="grid grid-cols-4 gap-1 rounded-lg bg-gray-200 p-1">
        {TABS.map((t, i) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`min-h-[48px] rounded-md text-[0.95rem] font-semibold ${tab === t ? 'bg-surface shadow' : 'text-ink'}`}>
            {i + 1}. {t}
          </button>
        ))}
      </nav>

      <div role="tabpanel" aria-label={tab}>
        {tab === 'Dados' && <HeaderForm apr={apr} editable={editable} onSaved={load} />}
        {tab === 'Checklist' && (
          <div className="flex flex-col gap-4">
            {apr.questions.map((q) => (
              <QuestionCard key={q.id} aprId={apr.id} question={q} total={apr.questions.length} editable={editable}
                answer={apr.answers.find((a) => a.questionId === q.id)} photos={apr.photos} userId={session.me.user.id} onChange={load} />
            ))}
          </div>
        )}
        {tab === 'Riscos' && <AnalysisEditor apr={apr} editable={editable} onSaved={load} />}
        {tab === 'Enviar' && <SubmitPanel apr={apr} check={check} editable={editable} onDone={load} goTo={setTab} />}
      </div>
    </>
  );
}

function lines(v: string) {
  return v.split('\n').map((s) => s.trim()).filter(Boolean);
}

function HeaderForm({ apr, editable, onSaved }: { apr: Apr; editable: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({
    location: apr.location,
    serviceDescription: apr.serviceDescription,
    responsibleName: apr.responsibleName,
    team: apr.team.map((m) => m.name).join('\n'),
    equipment: apr.equipment.join('\n'),
  });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const version = useRef(apr.rowVersion);
  const saved = useRef(form);

  async function save() {
    if (JSON.stringify(form) === JSON.stringify(saved.current)) return;
    setState('saving');
    try {
      const r = await api<{ rowVersion: number }>(`/aprs/${apr.id}`, 'PATCH', {
        rowVersion: version.current,
        location: form.location,
        serviceDescription: form.serviceDescription,
        responsibleName: form.responsibleName,
        team: lines(form.team).map((name) => ({ name })),
        equipment: lines(form.equipment),
      });
      version.current = r.rowVersion;
      saved.current = form;
      setState('saved');
      onSaved();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setState('error');
      setMessage(err?.status === 409 ? 'Outra pessoa alterou estes dados. Recarregue a página para ver a versão atual.' : err?.message ?? 'Não foi possível salvar.');
    }
  }

  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (v: string) => setForm({ ...form, [k]: v }), onBlur: save, disabled: !editable });
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <Field label="Local da atividade" required {...f('location')} />
        <Field label="Descrição do serviço" required multiline {...f('serviceDescription')} />
        <Field label="Responsável" required autoComplete="name" {...f('responsibleName')} />
        <Field label="Equipe executante" required multiline hint="Um nome por linha." {...f('team')} />
        <Field label="Equipamentos utilizados" multiline hint="Um por linha." {...f('equipment')} />
        <p className="text-sm text-muted">
          Data: {new Date(apr.activityDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
        </p>
        <div aria-live="polite">
          {state === 'saving' && <p className="text-sm text-muted">Salvando…</p>}
          {state === 'saved' && <p className="text-sm font-semibold text-ok">Salvo</p>}
          {state === 'error' && <Banner tone="danger">{message}</Banner>}
        </div>
      </div>
    </Card>
  );
}

function SubmitPanel({ apr, check, editable, onDone, goTo }: { apr: Apr; check: Check; editable: boolean; onDone: () => void; goTo: (t: Tab) => void }) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const canApprove = apr.status === 'IN_REVIEW' && session.can('apr.approve')(apr.unitId) && apr.createdBy !== session.me.user.id;

  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await api(`/aprs/${apr.id}/${path}`, 'POST', body);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  }

  const target = (i: Check['blocking'][number]): Tab =>
    i.questionId ? 'Checklist' : i.stepId || i.hazardId || i.code === 'STEPS_REQUIRED' ? 'Riscos' : 'Dados';

  return (
    <div className="flex flex-col gap-4">
      {check.blocking.length > 0 ? (
        <Card>
          <h2 className="text-lg font-bold text-danger">Pendências que impedem o envio ({check.blocking.length})</h2>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
            {check.blocking.map((i, n) => (
              <li key={n}>
                {i.message}{' '}
                <button type="button" className="min-h-[44px] font-semibold text-brand-ink underline" onClick={() => goTo(target(i))}>
                  Ir para {target(i).toLowerCase()}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Banner tone="ok" title="Sem pendências">A APR pode seguir para revisão.</Banner>
      )}
      {check.warnings.length > 0 && (
        <Banner tone="warn" title="Avisos">
          <ul className="list-disc pl-5">{check.warnings.map((w, n) => <li key={n}>{w.message}</li>)}</ul>
        </Banner>
      )}
      {error && <Banner tone="danger">{error}</Banner>}

      {editable && (
        <Button disabled={busy || !check.ready} onClick={() => act('submit')}>Enviar para revisão</Button>
      )}

      {canApprove && (
        <Card>
          <h2 className="text-lg font-bold">Revisão</h2>
          <p className="text-muted">Confira as condições no local antes de aprovar. A aprovação fica registrada em seu nome.</p>
          <div className="mt-3 flex flex-col gap-3">
            <Field label="Observação" multiline value={note} onChange={setNote} hint="Obrigatória para devolver." />
            <Button disabled={busy || !check.ready} onClick={() => act('approve', note ? { note } : {})}>Aprovar APR</Button>
            <Button variant="secondary" disabled={busy || !note.trim()} onClick={() => act('return', { note })}>Devolver para correção</Button>
          </div>
        </Card>
      )}
      {apr.status === 'IN_REVIEW' && apr.createdBy === session.me.user.id && <p className="text-muted">Aguardando revisão por outra pessoa.</p>}
    </div>
  );
}

export default function Page() {
  return <AppShell><Editor /></AppShell>;
}
