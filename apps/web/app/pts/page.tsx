'use client';
import { PT_STATUS, fmt } from '@/components/pt/labels';
import { AppShell } from '@/components/session';
import { Banner, Button, Card } from '@/components/ui';
import { usePaged } from '@/lib/paged';
import type { PtStatus } from '@/lib/types';

interface Row { id: string; number: string; status: PtStatus; location: string; description: string; starts_at: string; ends_at: string; validity: { valid: boolean } }

function List() {
  const { rows, more, loading, error, loadMore } = usePaged<Row>('/work-permits', 'starts_at');
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Permissões de Trabalho</h1>
        <a href="/pts/nova" className="inline-flex min-h-[52px] items-center rounded-lg bg-brand px-5 font-semibold text-white">Nova PT</a>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {rows?.length === 0 && <Card><p className="font-semibold">Nenhuma PT ainda.</p><p className="text-muted">Uma PT parte de uma APR aprovada.</p></Card>}
      <ul className="flex flex-col gap-3" aria-label="Lista de PTs">
        {rows?.map((r) => (
          <li key={r.id}>
            <a href={`/pts/${r.id}`} className="block rounded-xl bg-surface p-4 shadow-sm ring-1 ring-line hover:ring-2 hover:ring-brand">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold">{r.number}</span>
                <span className={`rounded-full px-3 py-1 text-sm font-bold ${r.validity.valid ? 'bg-ok-bg text-ok' : 'bg-gray-200 text-ink'}`}>
                  {r.validity.valid ? 'Vale agora' : 'Não vale'} · {PT_STATUS[r.status]}
                </span>
              </div>
              <p className="mt-1">{r.description}</p>
              <p className="text-sm text-muted">{r.location} · {fmt(r.starts_at)} até {fmt(r.ends_at)}</p>
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
