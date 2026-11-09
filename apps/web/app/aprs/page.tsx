'use client';
import { AppShell } from '@/components/session';
import { Banner, Button, Card, StatusBadge } from '@/components/ui';
import { usePaged } from '@/lib/paged';

interface Row { id: string; number: string; revision: number; status: string; activity_date: string; location: string; service_description: string; updated_at: string }

function List() {
  const { rows, more, loading, error, loadMore } = usePaged<Row>('/aprs', 'updated_at');
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">APRs</h1>
        <a href="/aprs/nova" className="inline-flex min-h-[52px] items-center rounded-lg bg-brand px-5 font-semibold text-white">Nova APR</a>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {rows?.length === 0 && (
        <Card><p className="font-semibold">Nenhuma APR ainda.</p><p className="text-muted">Toque em “Nova APR” para começar a análise de uma atividade.</p></Card>
      )}
      <ul className="flex flex-col gap-3" aria-label="Lista de APRs">
        {rows?.map((r) => (
          <li key={r.id}>
            <a href={`/aprs/${r.id}`} className="block rounded-xl bg-surface p-4 shadow-sm ring-1 ring-line hover:ring-2 hover:ring-brand">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold">{r.number}{r.revision > 0 ? ` · rev. ${r.revision}` : ''}</span>
                <StatusBadge status={r.status} />
              </div>
              <p className="mt-1">{r.service_description || 'Sem descrição'}</p>
              <p className="text-sm text-muted">{r.location || 'Local não informado'} · {new Date(r.activity_date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</p>
            </a>
          </li>
        ))}
      </ul>
      {more && <Button variant="secondary" disabled={loading} onClick={loadMore}>{loading ? 'Carregando…' : 'Mostrar mais antigas'}</Button>}
    </>
  );
}

export default function Page() {
  return <AppShell><List /></AppShell>;
}
