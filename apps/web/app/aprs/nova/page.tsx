'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell, useSession } from '@/components/session';
import { Banner, Field, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface Template { id: string; name: string; versions: { id: string; version: number; status: string }[] }
interface Matrix { id: string; name: string; version: number; status: string }
interface Unit { id: string; name: string }

function NewApr() {
  const router = useRouter();
  const { can } = useSession();
  const [options, setOptions] = useState<{ templates: { value: string; label: string }[]; matrices: { value: string; label: string }[]; units: Unit[] } | null>(null);
  const [form, setForm] = useState({ templateVersionId: '', riskMatrixId: '', unitId: '', activityDate: new Date().toISOString().slice(0, 10) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<Template[]>('/apr-templates'), api<Matrix[]>('/risk-matrices'), api<Unit[]>('/units')])
      .then(([t, m, u]) => {
        const templates = t.flatMap((tp) => tp.versions.filter((v) => v.status === 'PUBLISHED').map((v) => ({ value: v.id, label: `${tp.name} (versão ${v.version})` })));
        const matrices = m.filter((x) => x.status === 'PUBLISHED').map((x) => ({ value: x.id, label: `${x.name} (versão ${x.version})` }));
        const units = u.filter((x) => can('apr.write')(x.id));
        setOptions({ templates, matrices, units });
        setForm((f) => ({
          ...f,
          templateVersionId: templates.length === 1 ? templates[0]!.value : f.templateVersionId,
          riskMatrixId: matrices.length === 1 ? matrices[0]!.value : f.riskMatrixId,
          unitId: units.length === 1 ? units[0]!.id : f.unitId,
        }));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Erro ao carregar.'));
  }, [can]);

  if (!options) return error ? <Banner tone="danger">{error}</Banner> : <p className="text-muted">Carregando…</p>;
  if (options.templates.length === 0 || options.matrices.length === 0) {
    return <Banner tone="warn" title="Ainda não há modelo ou matriz publicados">O profissional de SST da empresa precisa revisar e publicar um modelo de APR e uma matriz de risco antes do primeiro uso.</Banner>;
  }
  if (options.units.length === 0) return <Banner tone="warn" title="Sem unidade liberada">Seu perfil não permite criar APR em nenhuma unidade.</Banner>;

  const ready = form.templateVersionId && form.riskMatrixId && form.unitId && form.activityDate;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const apr = await api<{ id: string }>('/aprs', 'POST', form);
          router.push(`/aprs/${apr.id}`);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Não foi possível criar.');
          setBusy(false);
        }
      }}
    >
      <h1 className="text-2xl font-bold">Nova APR</h1>
      {error && <Banner tone="danger">{error}</Banner>}
      <Select label="Tipo de serviço (modelo)" required value={form.templateVersionId} onChange={(v) => setForm({ ...form, templateVersionId: v })} options={options.templates} />
      <Select label="Unidade" required value={form.unitId} onChange={(v) => setForm({ ...form, unitId: v })} options={options.units.map((u) => ({ value: u.id, label: u.name }))} />
      <Field label="Data da atividade" type="date" required value={form.activityDate} onChange={(v) => setForm({ ...form, activityDate: v })} />
      <Select label="Matriz de risco" required value={form.riskMatrixId} onChange={(v) => setForm({ ...form, riskMatrixId: v })} options={options.matrices} />
      <button type="submit" disabled={!ready || busy} className="min-h-[52px] rounded-lg bg-brand px-5 font-semibold text-white disabled:bg-gray-400">
        {busy ? 'Criando…' : 'Criar APR'}
      </button>
    </form>
  );
}

export default function Page() {
  return <AppShell><NewApr /></AppShell>;
}
