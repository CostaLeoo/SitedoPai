'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, downloadDocument } from '@/lib/api';
import { Banner, Button, Card } from './ui';

interface IssuedDoc {
  id: string; sequence: number; statusAtIssue: string; verificationCode: string; issuedBy: string; issuedAt: string; sha256: string;
}

const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

/**
 * PDF com QR Code de verificação. Cada emissão fica arquivada e não muda; o PDF
 * mostra a situação NA EMISSÃO, e o QR Code mostra a situação atual.
 */
export function DocumentsPanel({ type, id, number, statusLabel }: { type: 'apr' | 'work_permit'; id: string; number: string; statusLabel: (s: string) => string }) {
  const [docs, setDocs] = useState<IssuedDoc[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = type === 'apr' ? 'aprs' : 'work-permits';

  const load = useCallback(() => {
    api<IssuedDoc[]>(`/documents?documentType=${type}&documentId=${id}`).then(setDocs).catch((e: ApiError) => setError(e.message));
  }, [type, id]);
  useEffect(load, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ id: string; sequence: number }>(`/${base}/${id}/documents`, 'POST');
      await downloadDocument(d.id, `${number}.pdf`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível emitir o PDF. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <h2 className="text-lg font-bold">PDF e verificação</h2>
      <p className="mt-1 text-muted">
        Cada emissão fica arquivada sem alteração. O PDF mostra a situação no momento da emissão; o QR Code impresso mostra a situação atual.
      </p>
      {error && <div className="mt-3"><Banner tone="danger">{error}</Banner></div>}
      <Button className="mt-4 w-full sm:w-auto" disabled={busy} onClick={issue}>{busy ? 'Gerando o PDF…' : 'Emitir PDF'}</Button>
      {docs && docs.length > 0 && (
        <ul className="mt-4 divide-y divide-line" aria-label="Emissões anteriores">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-semibold">Emissão {d.sequence} · {statusLabel(d.statusAtIssue)}</p>
                <p className="text-sm text-muted">{fmt(d.issuedAt)} por {d.issuedBy}</p>
                <p className="text-sm text-muted">Código <a className="font-mono underline" href={`/v/${d.verificationCode}`} target="_blank" rel="noreferrer">{d.verificationCode}</a></p>
              </div>
              <Button variant="secondary" onClick={() => downloadDocument(d.id, `${number}-${d.sequence}.pdf`).catch((e: ApiError) => setError(e.message))}>
                Baixar emissão {d.sequence}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
