'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Apr, Control, ControlType, Hazard, Step } from '@/lib/types';
import { Banner, Button, Field, Select } from './ui';

const CONTROL_LABEL: Record<ControlType, string> = {
  ELIMINATION: 'Eliminação do perigo',
  SUBSTITUTION: 'Substituição',
  ENGINEERING: 'Proteção coletiva / engenharia',
  ADMINISTRATIVE: 'Medida administrativa / procedimento',
  PPE: 'EPI',
};

const emptyControl = (): Control => ({ description: '', type: 'ENGINEERING', responsibleName: '', verified: false });
const emptyHazard = (): Hazard => ({ hazard: '', consequence: '', probability: null, severity: null, residualProbability: null, residualSeverity: null, controls: [emptyControl()] });

function riskLabel(apr: Apr, p: number | null, s: number | null) {
  if (p == null || s == null) return null;
  const score = p * s;
  const c = apr.matrix.classes.find((x) => score >= x.min && score <= x.max);
  return { score, label: c?.label ?? 'sem classe', acceptable: c?.acceptable ?? false };
}

function RiskResult({ apr, p, s, title }: { apr: Apr; p: number | null; s: number | null; title: string }) {
  const r = riskLabel(apr, p, s);
  if (!r) return <p className="text-sm text-muted">{title}: não avaliado</p>;
  return (
    <p className={`rounded px-2 py-1 text-sm font-bold ${r.acceptable ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'}`}>
      {title}: {r.label} (pontuação {r.score}) — {r.acceptable ? 'aceitável' : 'não aceitável'}
    </p>
  );
}

type Status = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

/** Edita etapas → perigos → controles. Salva sozinho 1,5 s após a última mudança. */
export function AnalysisEditor({ apr, editable, onSaved }: { apr: Apr; editable: boolean; onSaved: () => void }) {
  const [steps, setSteps] = useState<Step[]>(apr.steps.length ? apr.steps : []);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const version = useRef(apr.analysisVersion);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(steps);
  latest.current = steps;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function change(next: Step[]) {
    setSteps(next);
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1500);
  }

  async function save() {
    if (timer.current) clearTimeout(timer.current);
    setStatus('saving');
    setMessage(null);
    try {
      const body = {
        analysisVersion: version.current,
        steps: latest.current
          .filter((s) => s.description.trim())
          .map((s) => ({
            description: s.description,
            hazards: s.hazards.filter((h) => h.hazard.trim() && h.consequence.trim()).map((h) => ({
              hazard: h.hazard, consequence: h.consequence, probability: h.probability, severity: h.severity,
              residualProbability: h.residualProbability, residualSeverity: h.residualSeverity,
              controls: h.controls.filter((c) => c.description.trim()).map((c) => ({
                description: c.description, type: c.type, responsibleName: c.responsibleName, verified: c.verified,
              })),
            })),
          })),
      };
      const r = await api<{ analysisVersion: number }>(`/aprs/${apr.id}/analysis`, 'PUT', body);
      version.current = r.analysisVersion;
      setStatus('saved');
      onSaved();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setStatus(err?.status === 409 ? 'conflict' : 'error');
      setMessage(err?.status === 409 ? 'Outra pessoa alterou a análise. Recarregue a página para ver a versão atual.' : err?.message ?? 'Não foi possível salvar.');
    }
  }

  const p = apr.matrix.probabilityLevels.map((l) => ({ value: String(l.value), label: `${l.value} — ${l.label}` }));
  const s = apr.matrix.severityLevels.map((l) => ({ value: String(l.value), label: `${l.value} — ${l.label}` }));
  const num = (v: string) => (v ? Number(v) : null);
  const setStep = (i: number, fn: (x: Step) => Step) => change(steps.map((x, j) => (j === i ? fn(x) : x)));
  const setHazard = (i: number, k: number, fn: (x: Hazard) => Hazard) => setStep(i, (st) => ({ ...st, hazards: st.hazards.map((h, j) => (j === k ? fn(h) : h)) }));

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-[68px] z-[5] -mx-4 border-b border-line bg-canvas px-4 py-2" aria-live="polite">
        {status === 'dirty' && <p className="text-sm text-muted">Alterações ainda não salvas…</p>}
        {status === 'saving' && <p className="text-sm text-muted">Salvando…</p>}
        {status === 'saved' && <p className="text-sm font-semibold text-ok">Análise salva</p>}
        {(status === 'error' || status === 'conflict') && <Banner tone="danger">{message}</Banner>}
        {status === 'error' && <Button variant="secondary" className="mt-2" onClick={save}>Tentar salvar de novo</Button>}
      </div>

      {steps.length === 0 && <p className="text-muted">Descreva as etapas da atividade, os perigos de cada etapa e as medidas de controle.</p>}

      {steps.map((st, i) => (
        <section key={i} className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-line" aria-label={`Etapa ${i + 1}`}>
          <h3 className="text-lg font-bold">Etapa {i + 1}</h3>
          <div className="mt-2 flex flex-col gap-3">
            <Field label="O que é feito nesta etapa" required multiline value={st.description} disabled={!editable}
              onChange={(v) => setStep(i, (x) => ({ ...x, description: v }))} />
            {st.hazards.map((h, k) => (
              <div key={k} className="flex flex-col gap-3 rounded-lg border-2 border-line p-3">
                <h4 className="font-bold">Perigo {k + 1}</h4>
                <Field label="Perigo" required value={h.hazard} disabled={!editable} onChange={(v) => setHazard(i, k, (x) => ({ ...x, hazard: v }))} />
                <Field label="Possíveis consequências" required value={h.consequence} disabled={!editable} onChange={(v) => setHazard(i, k, (x) => ({ ...x, consequence: v }))} />
                <p className="font-semibold">Risco sem os controles</p>
                <Select label="Probabilidade" value={h.probability?.toString() ?? ''} options={p} disabled={!editable} onChange={(v) => setHazard(i, k, (x) => ({ ...x, probability: num(v) }))} />
                <Select label="Severidade" value={h.severity?.toString() ?? ''} options={s} disabled={!editable} onChange={(v) => setHazard(i, k, (x) => ({ ...x, severity: num(v) }))} />
                <RiskResult apr={apr} p={h.probability} s={h.severity} title="Risco inicial" />

                <p className="font-semibold">Medidas de prevenção e controle</p>
                {h.controls.map((c, m) => (
                  <div key={m} className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3">
                    <Field label={`Medida ${m + 1}`} value={c.description} disabled={!editable}
                      onChange={(v) => setHazard(i, k, (x) => ({ ...x, controls: x.controls.map((cc, n) => (n === m ? { ...cc, description: v } : cc)) }))} />
                    <Select label="Tipo de medida" value={c.type} disabled={!editable} options={Object.entries(CONTROL_LABEL).map(([value, label]) => ({ value, label }))}
                      onChange={(v) => setHazard(i, k, (x) => ({ ...x, controls: x.controls.map((cc, n) => (n === m ? { ...cc, type: (v || 'ENGINEERING') as ControlType } : cc)) }))} />
                    <Field label="Responsável pela implementação" value={c.responsibleName} disabled={!editable}
                      onChange={(v) => setHazard(i, k, (x) => ({ ...x, controls: x.controls.map((cc, n) => (n === m ? { ...cc, responsibleName: v } : cc)) }))} />
                    <label className="flex min-h-[48px] items-center gap-3 font-semibold">
                      <input type="checkbox" className="h-6 w-6" checked={c.verified} disabled={!editable}
                        onChange={(e) => setHazard(i, k, (x) => ({ ...x, controls: x.controls.map((cc, n) => (n === m ? { ...cc, verified: e.target.checked } : cc)) }))} />
                      Medida verificada no local
                    </label>
                  </div>
                ))}
                {editable && <Button variant="secondary" onClick={() => setHazard(i, k, (x) => ({ ...x, controls: [...x.controls, emptyControl()] }))}>Adicionar medida</Button>}

                <p className="font-semibold">Risco residual (com os controles)</p>
                <Select label="Probabilidade residual" value={h.residualProbability?.toString() ?? ''} options={p} disabled={!editable} onChange={(v) => setHazard(i, k, (x) => ({ ...x, residualProbability: num(v) }))} />
                <Select label="Severidade residual" value={h.residualSeverity?.toString() ?? ''} options={s} disabled={!editable} onChange={(v) => setHazard(i, k, (x) => ({ ...x, residualSeverity: num(v) }))} />
                <RiskResult apr={apr} p={h.residualProbability} s={h.residualSeverity} title="Risco residual" />
                {editable && (
                  <Button variant="ghost" onClick={() => window.confirm(`Remover o perigo ${k + 1}?`) && setStep(i, (x) => ({ ...x, hazards: x.hazards.filter((_, j) => j !== k) }))}>
                    Remover perigo {k + 1}
                  </Button>
                )}
              </div>
            ))}
            {editable && <Button variant="secondary" onClick={() => setStep(i, (x) => ({ ...x, hazards: [...x.hazards, emptyHazard()] }))}>Adicionar perigo</Button>}
            {editable && (
              <Button variant="ghost" onClick={() => window.confirm(`Remover a etapa ${i + 1}?`) && change(steps.filter((_, j) => j !== i))}>
                Remover etapa {i + 1}
              </Button>
            )}
          </div>
        </section>
      ))}
      {editable && <Button onClick={() => change([...steps, { description: '', hazards: [emptyHazard()] }])}>Adicionar etapa</Button>}
    </div>
  );
}
