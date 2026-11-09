'use client';
import { useRouter } from 'next/navigation';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { currentUser, logout } from '@/lib/auth';
import { clearTenant, getTenant, setTenant } from '@/lib/tenant';
import type { Me } from '@/lib/types';
import { Banner, Button } from './ui';

interface Session {
  me: Me;
  tenant: Me['tenants'][number];
  can: (permission: UiPermission) => (unitId: string) => boolean;
}

const Ctx = createContext<Session | null>(null);
export const useSession = () => useContext(Ctx)!;

// Espelha as permissões da API, só para esconder botões. Quem decide é sempre a API.
const ROLES = {
  'apr.write': ['SST', 'SUPERVISOR', 'EXECUTOR'],
  'apr.approve': ['SST', 'SUPERVISOR'],
  'pt.write': ['SST', 'SUPERVISOR', 'EXECUTOR'],
  'pt.review': ['SST'],
  'pt.release': ['SST', 'SUPERVISOR'],
  'pt.field': ['SST', 'SUPERVISOR', 'EXECUTOR'],
} as const;
export type UiPermission = keyof typeof ROLES;

/** Exige login e empresa selecionada; mostra o cabeçalho do aplicativo. */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!(await currentUser())) return router.replace('/entrar');
      try {
        const me = await api<Me>('/me');
        const active = me.tenants.filter((t) => t.status !== 'SUSPENDED');
        let tenant = active.find((t) => t.tenantId === getTenant());
        if (!tenant && active.length === 1) {
          tenant = active[0]!;
          setTenant(tenant.tenantId);
        }
        if (!tenant) return router.replace('/empresa');
        const t = tenant;
        setSession({
          me,
          tenant: t,
          can: (p) => (unitId) => t.roles.some((r) => (ROLES[p] as readonly string[]).includes(r.role) && (r.scopeType === 'TENANT' || r.unitId === unitId)),
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Não foi possível carregar sua sessão.');
      }
    })();
  }, [router]);

  if (error) return <main className="mx-auto max-w-screen-sm p-4"><Banner tone="danger" title="Algo deu errado">{error}</Banner></main>;
  if (!session) return <main className="mx-auto max-w-screen-sm p-4" aria-busy="true"><p className="text-muted">Carregando…</p></main>;

  return (
    <Ctx.Provider value={session}>
      <header className="sticky top-0 z-10 bg-ink text-white">
        <div className="mx-auto flex max-w-screen-sm items-center justify-between gap-3 px-4 py-3">
          <nav aria-label="Principal" className="flex items-center gap-1">
            <a href="/aprs" className="min-h-[44px] content-center pr-2 font-bold">SitedoPai</a>
            <a href="/aprs" className="min-h-[44px] content-center rounded px-2 underline-offset-4 hover:underline">APRs</a>
            <a href="/pts" className="min-h-[44px] content-center rounded px-2 underline-offset-4 hover:underline">PTs</a>
            {session.tenant.roles.some((r) => r.role === 'COMPANY_ADMIN' && r.scopeType === 'TENANT') && (
              <a href="/assinatura" className="min-h-[44px] content-center rounded px-2 underline-offset-4 hover:underline">Conta</a>
            )}
          </nav>
          <div className="flex items-center gap-2 text-sm">
            <span className="hidden max-w-[10rem] truncate sm:inline" title={session.tenant.name}>{session.tenant.name}</span>
            <button
              type="button"
              className="min-h-[44px] rounded px-2 underline underline-offset-4"
              onClick={async () => {
                clearTenant();
                await logout();
              }}
            >
              Sair
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-screen-sm flex-col gap-4 p-4 pb-24">
        <TenantStatusBanner status={session.tenant.tenantStatus} />
        {children}
      </main>
    </Ctx.Provider>
  );
}

/** Aviso da situação comercial. Nunca impede as ações de segurança das PTs. */
function TenantStatusBanner({ status }: { status: Me['tenants'][number]['tenantStatus'] }) {
  if (status === 'GRACE_PERIOD') {
    return <Banner tone="warn" title="Pagamento em atraso">O sistema continua funcionando normalmente durante o período de tolerância. Fale com o administrador da sua empresa.</Banner>;
  }
  if (status === 'READ_ONLY' || status === 'CLOSED') {
    return (
      <Banner tone="danger" title={status === 'CLOSED' ? 'Contrato encerrado: somente consulta' : 'Conta em modo somente consulta'}>
        Não é possível criar APRs nem liberar PTs. Continuam liberados: consultar e exportar documentos e, nas PTs em andamento, suspender, registrar entrada e saída, medir gases e encerrar.
      </Banner>
    );
  }
  return null;
}

export function TenantPicker() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>('/me').then(setMe).catch(() => router.replace('/entrar'));
  }, [router]);
  if (!me) return <p className="text-muted">Carregando…</p>;
  const active = me.tenants.filter((t) => t.status !== 'SUSPENDED');
  if (active.length === 0 && me.platformAdmin) {
    return <Button onClick={() => router.replace('/plataforma')}>Abrir o painel da plataforma</Button>;
  }
  if (active.length === 0) return <Banner tone="warn" title="Nenhuma empresa liberada">Peça ao administrador da sua empresa para liberar o seu acesso.</Banner>;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">Escolha a empresa</h1>
      {me.platformAdmin && <Button variant="ghost" onClick={() => router.replace('/plataforma')}>Painel da plataforma</Button>}
      {active.map((t) => (
        <Button key={t.tenantId} variant="secondary" className="text-left" onClick={() => { setTenant(t.tenantId); router.replace('/aprs'); }}>
          {t.name}
        </Button>
      ))}
    </div>
  );
}
