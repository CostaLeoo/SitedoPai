'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/session';
import { Banner, Field, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface AprRow { id: string; number: string; revision: number; service_description: string }
interface PtType { id: string; name: string; version: number; status: string; max_validity_minutes: number }

/** datetime-local usa hora local, sem fuso; convertemos para ISO com fuso. */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const toIso = (v: string) => new Date(v).toISOString();

function NewPt() {
  const router = useRouter();
  const [aprs, setAprs] = useState<AprRow[] | null>(null);
  const [types, setTypes] = useState<PtType[]>([]);
  const now = new Date();
  const [form, setForm] = useState({ aprId: '', ptTypeId: '', location: '', description: '', startsAt: toLocalInput(now), endsAt: toLocalInput(new Date(now.getTime() + 4 * 3600_000)) });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<AprRow[]>('/aprs?status=APPROVED'), api<PtType[]>('/pt-types')]).then(([a, t]) => {
      setAprs(a);
      const pub = t.filter((x) => x.status === 'PUBLISHED');
      setTypes(pub);
      setForm((f) => ({ ...f, aprId: a.length === 1 ? a[0]!.id : f.aprId, ptTypeId: pub.length === 1 ? pub[0]!.id : f.ptTypeId }));
    }).catch((e) => setError(e instanceof ApiError ? e : null));
  }, []);

  if (!aprs) return error ? <Banner tone="danger">{error.message}</Banner> : <p className="text-muted">Carregando…</p>;
  if (aprs.length === 0) return <Banner tone="warn" title="Nenhuma APR aprovada">A PT precisa partir de uma APR aprovada.</Banner>;
  if (types.length === 0) return <Banner tone="warn" title="Nenhum tipo de PT publicado">O SST da empresa precisa configurar e publicar os tipos de PT.</Banner>;
  const type = types.find((t) => t.id === form.ptTypeId);
  const fieldError = (f: string) => error?.fields.find((x) => x.field === f)?.message;

  return (
    <form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const pt = await api<{ id: string }>('/work-permits', 'POST', { ...form, startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt) });
        router.push(`/pts/${pt.id}`);
      } catch (err) {
        setError(err instanceof ApiError ? err : new ApiError(0, 'ERROR', 'Não foi possível criar.'));
        setBusy(false);
      }
    }}>
      <h1 className="text-2xl font-bold">Nova PT</h1>
      {error && <Banner tone="danger">{error.message}</Banner>}
      <Select label="APR aprovada" required value={form.aprId} onChange={(v) => setForm({ ...form, aprId: v })}
        options={aprs.map((a) => ({ value: a.id, label: `${a.number}${a.revision ? ` rev. ${a.revision}` : ''} — ${a.service_description}` }))} />
      <Select label="Tipo de PT" required value={form.ptTypeId} onChange={(v) => setForm({ ...form, ptTypeId: v })}
        options={types.map((t) => ({ value: t.id, label: `${t.name} (v${t.version})` }))} />
      <Field label="Local" required value={form.location} onChange={(v) => setForm({ ...form, location: v })} error={fieldError('location')} />
      <Field label="Descrição da atividade" required multiline value={form.description} onChange={(v) => setForm({ ...form, description: v })} error={fieldError('description')} />
      <Field label="Início" type="datetime-local" required value={form.startsAt} onChange={(v) => setForm({ ...form, startsAt: v })} />
      <Field label="Fim" type="datetime-local" required value={form.endsAt} onChange={(v) => setForm({ ...form, endsAt: v })} error={fieldError('endsAt')}
        hint={type ? `Validade máxima deste tipo: ${Math.floor(type.max_validity_minutes / 60)} h ${type.max_validity_minutes % 60} min.` : undefined} />
      <button type="submit" disabled={busy || !form.aprId || !form.ptTypeId || !form.location || !form.description}
        className="min-h-[52px] rounded-lg bg-brand px-5 font-semibold text-white disabled:bg-gray-400">{busy ? 'Criando…' : 'Criar PT'}</button>
    </form>
  );
}

export default function Page() {
  return <AppShell><NewPt /></AppShell>;
}
