'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Banner, Card } from '@/components/ui';
import { API_URL } from '@/lib/config';

interface Verification {
  documentType: 'apr' | 'work_permit'; documentNumber: string; documentRevision: number; company: string; issuedAt: string; sha256: string;
  statusAtIssueText: string; currentStatusText: string; validFrom: string | null; validUntil: string | null; currentlyValid: boolean; checkedAt: string;
}

const fmt = (d: string) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + ' (horário de Brasília)';

/**
 * Página pública do QR Code. Sem login: mostra só se o documento é autêntico e
 * a situação atual. Nenhum dado pessoal nem conteúdo do documento.
 */
export default function Verify() {
  const { code } = useParams<{ code: string }>();
  const [v, setV] = useState<Verification | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');

  useEffect(() => {
    fetch(`${API_URL}/verify/${encodeURIComponent(code)}`)
      .then(async (r) => {
        if (r.status === 404) return setState('notfound');
        if (!r.ok) return setState('error');
        setV(await r.json());
        setState('ok');
      })
      .catch(() => setState('error'));
  }, [code]);

  const isPt = v?.documentType === 'work_permit';
  return (
    <main className="mx-auto flex min-h-dvh max-w-screen-sm flex-col gap-5 p-6">
      <div>
        <p className="text-sm font-semibold text-muted">SitedoPai · verificação de documento</p>
        <h1 className="mt-1 text-2xl font-bold">{v ? `${isPt ? 'Permissão de Trabalho' : 'APR'} ${v.documentNumber}` : 'Verificação'}</h1>
      </div>
      {state === 'loading' && <p className="text-muted">Consultando…</p>}
      {state === 'notfound' && (
        <Banner tone="danger" title="Documento não encontrado">
          Este código não corresponde a nenhum documento emitido pelo sistema. Não aceite o papel como autêntico.
        </Banner>
      )}
      {state === 'error' && <Banner tone="warn" title="Não foi possível consultar agora">Confira a conexão e tente de novo. Enquanto isso, não trate o papel como autorização.</Banner>}
      {v && (
        <>
          {isPt ? (
            v.currentlyValid
              ? <Banner tone="ok" title="PT válida neste momento">{v.validUntil && `Vale até ${fmt(v.validUntil)}.`}</Banner>
              : <Banner tone="danger" title="NÃO VALE COMO AUTORIZAÇÃO">Situação atual: {v.currentStatusText}. Não execute a atividade com base neste papel.</Banner>
          ) : (
            v.currentlyValid
              ? <Banner tone="ok" title="APR aprovada">Situação atual: {v.currentStatusText}.</Banner>
              : <Banner tone="danger" title="APR não aprovada">Situação atual: {v.currentStatusText}.</Banner>
          )}
          <Card>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted">Empresa</dt><dd className="font-semibold">{v.company}</dd>
              {v.documentRevision > 0 && <><dt className="text-muted">Revisão</dt><dd>{v.documentRevision}</dd></>}
              <dt className="text-muted">Emitido em</dt><dd>{fmt(v.issuedAt)}</dd>
              <dt className="text-muted">Situação na emissão</dt><dd>{v.statusAtIssueText}</dd>
              <dt className="text-muted">Situação atual</dt><dd className="font-semibold">{v.currentStatusText}</dd>
              {isPt && v.validFrom && <><dt className="text-muted">Período</dt><dd>{fmt(v.validFrom)} até {v.validUntil && fmt(v.validUntil)}</dd></>}
              <dt className="text-muted">Consultado em</dt><dd>{fmt(v.checkedAt)}</dd>
            </dl>
            <p className="mt-4 text-sm text-muted">Hash SHA-256 do PDF emitido (para conferência do arquivo):</p>
            <p className="break-all font-mono text-sm">{v.sha256}</p>
          </Card>
          <p className="text-sm text-muted">O conteúdo do documento só pode ser visto por quem tem acesso no sistema.</p>
        </>
      )}
    </main>
  );
}
