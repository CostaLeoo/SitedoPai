'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, photoUrl, uploadPhoto } from '@/lib/api';
import { preparePhoto } from '@/lib/image';
import type { Answer, AnswerRow, Photo, Question } from '@/lib/types';
import { Banner, Button, Field } from './ui';

const LABEL: Record<Answer, string> = { YES: 'Sim', NO: 'Não', NA: 'N/A (Não se aplica)' };
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string } | { kind: 'conflict'; message: string };

export function isMismatch(q: Question, a: Answer) {
  return a !== q.expectedAnswer && !(a === 'NA' && q.allowNa);
}
function needsJustification(q: Question, a: Answer) {
  return q.justificationOn.includes(a) || (q.justificationOn.includes('MISMATCH') && isMismatch(q, a));
}

export function QuestionCard(props: {
  /** Base das rotas de resposta: /aprs/:id ou /work-permits/:id. */
  basePath: string;
  /** Só a APR tem fotos por pergunta, por enquanto. */
  photoAprId?: string;
  question: Question;
  total: number;
  answer?: AnswerRow;
  photos?: Photo[];
  editable: boolean;
  userId: string;
  onChange: () => void;
}) {
  const { question: q, answer } = props;
  const [value, setValue] = useState<Answer | null>(answer?.answer ?? null);
  const [justification, setJustification] = useState(answer?.justification ?? '');
  const [corrective, setCorrective] = useState(answer?.correctiveAction ?? '');
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const version = useRef<number | undefined>(answer?.version);

  useEffect(() => {
    version.current = answer?.version;
  }, [answer?.version]);

  // Salvamentos da mesma pergunta acontecem em fila: um segundo envio só sai
  // depois que o primeiro voltar com a versão nova (evita falso conflito).
  const queue = useRef<Promise<void>>(Promise.resolve());
  function persist(next: { answer: Answer; justification: string; correctiveAction: string }) {
    queue.current = queue.current.then(() => send(next));
    return queue.current;
  }

  async function send(next: { answer: Answer; justification: string; correctiveAction: string }) {
    setSave({ kind: 'saving' });
    try {
      const r = await api<{ version: number }>(`${props.basePath}/answers/${q.id}`, 'PUT', {
        answer: next.answer,
        justification: next.justification || null,
        correctiveAction: next.correctiveAction || null,
        version: version.current,
      });
      version.current = r.version;
      setSave({ kind: 'saved' });
      props.onChange();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) setSave({ kind: 'conflict', message: 'Outra pessoa alterou esta resposta. Recarregue a página para ver a versão atual.' });
      else setSave({ kind: 'error', message: err?.message ?? 'Não foi possível salvar.' });
    }
  }

  const mismatch = value ? isMismatch(q, value) : false;
  const showJustification = value ? needsJustification(q, value) : false;
  const showCorrective = mismatch && q.mismatchEffect !== 'ALERT';
  const name = `q-${q.id}`;
  const headingId = `${name}-title`;

  return (
    <article aria-labelledby={headingId} className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-line" data-question={q.position}>
      <p className="text-sm font-semibold text-muted">Pergunta {q.position} de {props.total}{q.required ? '' : ' · opcional'}</p>
      <h3 id={headingId} className="mt-1 text-lg font-bold">{q.position}. {q.text}</h3>
      <div className="mt-1 flex flex-wrap gap-2 text-sm">
        {q.criticality === 'CRITICAL' && <span className="rounded bg-danger-bg px-2 py-0.5 font-bold text-danger">Pergunta crítica</span>}
        {q.normativeRef && <span className="rounded bg-gray-100 px-2 py-0.5 text-muted">Ref.: {q.normativeRef}</span>}
      </div>
      {q.helpText && <p className="mt-2 text-muted">{q.helpText}</p>}

      <fieldset className="mt-3" disabled={!props.editable}>
        <legend className="sr-only">Resposta da pergunta {q.position}</legend>
        <div className="flex flex-col gap-2">
          {(['YES', 'NO', 'NA'] as Answer[]).map((opt) => {
            const disabled = opt === 'NA' && !q.allowNa;
            const checked = value === opt;
            return (
              <label
                key={opt}
                className={`flex min-h-[56px] cursor-pointer items-center gap-3 rounded-lg border-2 px-4 text-[1.0625rem] font-semibold
                  ${checked ? 'border-ink bg-ink text-white' : 'border-line bg-surface'}
                  ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={opt}
                  checked={checked}
                  disabled={disabled}
                  className="h-6 w-6 accent-current"
                  onChange={() => {
                    setValue(opt);
                    void persist({ answer: opt, justification, correctiveAction: corrective });
                  }}
                />
                {LABEL[opt]}
                {disabled && <span className="ml-auto text-sm font-normal">não permitido</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <SaveIndicator state={save} onRetry={value ? () => persist({ answer: value, justification, correctiveAction: corrective }) : undefined} />

      {mismatch && (
        <div className="mt-3">
          {q.mismatchEffect === 'ALERT' && <Banner tone="warn" title="Resposta diferente da esperada">Confira as medidas de controle antes de seguir.</Banner>}
          {q.mismatchEffect === 'PENDING' && <Banner tone="warn" title="Ação corretiva necessária">Registre o que foi feito para corrigir a condição.</Banner>}
          {q.mismatchEffect === 'BLOCK' && (
            <Banner tone="danger" title="Atividade bloqueada">Corrija a condição, registre a ação corretiva e peça a outra pessoa para avaliar de novo.</Banner>
          )}
        </div>
      )}

      {(showJustification || showCorrective) && (
        <div className="mt-3 flex flex-col gap-3">
          {showJustification && (
            <Field label="Justificativa" required multiline value={justification} disabled={!props.editable} onChange={setJustification}
              onBlur={() => value && justification !== (answer?.justification ?? '') && persist({ answer: value, justification, correctiveAction: corrective })} />
          )}
          {showCorrective && (
            <Field label="Ação corretiva" required multiline value={corrective} disabled={!props.editable} onChange={setCorrective}
              hint="O que foi feito para deixar a condição segura."
              onBlur={() => value && corrective !== (answer?.correctiveAction ?? '') && persist({ answer: value, justification, correctiveAction: corrective })} />
          )}
        </div>
      )}

      {q.mismatchEffect === 'BLOCK' && mismatch && answer?.correctiveAction && (
        <Reassess {...props} version={version} />
      )}

      {props.photoAprId && q.photosMax > 0 && <Photos {...props} photos={props.photos ?? []} aprId={props.photoAprId} />}
    </article>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'saving') return <p className="mt-2 text-sm text-muted" role="status">Salvando…</p>;
  if (state.kind === 'saved') return <p className="mt-2 text-sm font-semibold text-ok" role="status">Salvo</p>;
  return (
    <div className="mt-2">
      <Banner tone="danger">{state.message}</Banner>
      {state.kind === 'error' && onRetry && <Button variant="secondary" className="mt-2" onClick={onRetry}>Tentar salvar de novo</Button>}
    </div>
  );
}

function Reassess(props: { basePath: string; question: Question; answer?: AnswerRow; editable: boolean; userId: string; onChange: () => void; version: { current?: number } }) {
  const a = props.answer!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passed = a.reassessedAnswer && !isMismatch(props.question, a.reassessedAnswer);
  const sameUser = a.answeredBy === props.userId;

  async function send(answer: Answer) {
    setBusy(true);
    setError(null);
    try {
      await api(`${props.basePath}/answers/${props.question.id}/reassess`, 'POST', { answer, version: props.version.current });
      props.onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível registrar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border-2 border-dashed border-line p-3">
      <p className="font-bold">Nova avaliação após a ação corretiva</p>
      {a.reassessedAnswer ? (
        <p className={passed ? 'font-semibold text-ok' : 'font-semibold text-danger'}>
          {passed ? 'Condição confirmada como segura.' : 'A nova avaliação não confirmou a condição segura. A atividade continua bloqueada.'}
        </p>
      ) : (
        <p className="text-muted">Aguardando outra pessoa avaliar de novo.</p>
      )}
      {props.editable && !sameUser && (
        <div className="mt-2 flex flex-col gap-2">
          <p>A condição agora atende à pergunta?</p>
          <Button disabled={busy} variant="secondary" onClick={() => send(props.question.expectedAnswer)}>Sim, avaliei e está segura</Button>
          <Button disabled={busy} variant="secondary" onClick={() => send(props.question.expectedAnswer === 'YES' ? 'NO' : 'YES')}>Não, continua insegura</Button>
        </div>
      )}
      {props.editable && sameUser && <p className="mt-1 text-sm text-muted">Quem respondeu não pode fazer a nova avaliação.</p>}
      {error && <div className="mt-2"><Banner tone="danger">{error}</Banner></div>}
    </div>
  );
}

function Photos(props: { aprId: string; question: Question; photos: Photo[]; editable: boolean; onChange: () => void }) {
  const { question: q } = props;
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const mine = props.photos.filter((p) => p.questionId === q.id);
  const room = q.photosMax - mine.length;

  useEffect(() => {
    let alive = true;
    for (const p of mine) {
      if (urls[p.id]) continue;
      photoUrl(props.aprId, p.id).then((u) => alive && setUrls((x) => ({ ...x, [p.id]: u }))).catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [mine, props.aprId, urls]);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files).slice(0, Math.max(room, 0))) {
        const prepared = await preparePhoto(f);
        await uploadPhoto(props.aprId, q.id, prepared.blob, prepared.name);
      }
      if (files.length > room) setError(`Só cabem mais ${room} foto(s) nesta pergunta; as demais não foram enviadas.`);
      props.onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar a foto.');
    } finally {
      setBusy(false);
      if (camera.current) camera.current.value = '';
      if (gallery.current) gallery.current.value = '';
    }
  }

  async function remove(id: string, n: number) {
    if (!window.confirm(`Remover a foto ${n}?`)) return;
    try {
      await api(`/aprs/${props.aprId}/photos/${id}`, 'DELETE');
      props.onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível remover.');
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="font-semibold">
        Fotos: {mine.length} de {q.photosMax}
        {q.photosRequired > 0 && <span className={mine.length >= q.photosRequired ? 'text-ok' : 'text-danger'}> · mínimo {q.photosRequired}</span>}
      </p>
      {mine.length > 0 && (
        <ul className="mt-2 grid grid-cols-3 gap-2" aria-label={`Fotos da pergunta ${q.position}`}>
          {mine.map((p, i) => (
            <li key={p.id} className="relative">
              {urls[p.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={urls[p.id]} alt={`Foto ${i + 1} da pergunta ${q.position}`} className="aspect-square w-full rounded-lg object-cover" />
              ) : (
                <div className="aspect-square w-full rounded-lg bg-gray-200" aria-label="Carregando foto" />
              )}
              {props.editable && (
                <button type="button" onClick={() => remove(p.id, i + 1)} aria-label={`Remover foto ${i + 1}`}
                  className="absolute right-1 top-1 min-h-[44px] min-w-[44px] rounded-full bg-ink/80 text-xl font-bold text-white">×</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.editable && room > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button variant="secondary" disabled={busy} onClick={() => camera.current?.click()}>{busy ? 'Enviando…' : 'Tirar foto'}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => gallery.current?.click()}>Adicionar fotos da galeria</Button>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => add(e.target.files)} data-testid={`camera-${q.position}`} />
          <input ref={gallery} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(e) => add(e.target.files)} data-testid={`gallery-${q.position}`} />
        </div>
      )}
      {error && <div className="mt-2"><Banner tone="danger">{error}</Banner></div>}
    </div>
  );
}
