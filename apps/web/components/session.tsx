'use client';
import { Building2, ClipboardCheck, KeyRound, LayoutDashboard, LogOut, Menu, Settings2, ShieldCheck, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
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
export function AppShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
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
      <Shell session={session} wide={wide}>
        <TenantStatusBanner status={session.tenant.tenantStatus} />
        {children}
      </Shell>
    </Ctx.Provider>
  );
}

const NAV = [
  { href: '/painel', label: 'Visão geral', icon: LayoutDashboard },
  { href: '/aprs', label: 'APRs', icon: ClipboardCheck },
  { href: '/pts', label: 'Permissões de Trabalho', icon: KeyRound },
] as const;

const initials = (name: string) => name.replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');

/**
 * Estrutura do aplicativo (identidade inspirada no Vigia): menu lateral azul
 * profundo no computador, gaveta no celular, barra superior com a empresa ativa.
 */
function Shell({ session, wide, children }: { session: Session; wide?: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isAdmin = session.tenant.roles.some((r) => r.role === 'COMPANY_ADMIN' && r.scopeType === 'TENANT');
  const items = [
    ...NAV,
    ...(isAdmin ? [{ href: '/assinatura', label: 'Conta da empresa', icon: Building2 }] : []),
    ...(session.me.platformAdmin ? [{ href: '/plataforma', label: 'Painel da plataforma', icon: Settings2 }] : []),
  ];
  const others = session.me.tenants.filter((t) => t.status !== 'SUSPENDED').length > 1;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const sidebar = (
    <div className="flex h-full flex-col px-4 py-6">
      <a href="/painel" className="mb-8 flex items-center gap-3 px-3 text-white">
        <ShieldCheck aria-hidden size={30} className="text-mint" />
        <span>
          <strong className="block text-2xl font-bold tracking-tight">SitedoPai</strong>
          <span className="block text-[0.65rem] uppercase tracking-[0.15em] text-navy-text">segurança operacional</span>
        </span>
      </a>
      <p className="mb-3 px-3 text-[0.7rem] font-semibold uppercase tracking-[0.15em] text-navy-text">Área de trabalho</p>
      <nav aria-label="Principal" className="flex flex-col gap-1">
        {items.map((i) => {
          const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
          const Icon = i.icon;
          return (
            <a key={i.href} href={i.href} aria-current={active ? 'page' : undefined}
              className={`flex min-h-[48px] items-center gap-3 rounded-lg px-3 text-[0.95rem] ${active ? 'bg-navy-active font-semibold text-white' : 'text-navy-text hover:bg-navy-hover hover:text-white'}`}>
              <Icon aria-hidden size={20} className={active ? 'text-mint' : ''} />
              <span>{i.label}</span>
              {active && <span aria-hidden className="ml-auto h-1.5 w-1.5 rounded-full bg-mint" />}
            </a>
          );
        })}
      </nav>
      <div className="mt-auto pt-6">
        <div className="rounded-lg border border-navy-active bg-navy-2 p-4 text-navy-text">
          <ShieldCheck aria-hidden size={20} className="mb-2 text-mint" />
          <strong className="block text-sm text-white">Segurança antes da velocidade</strong>
          <p className="mt-1 text-sm">Na dúvida, não libere. Qualquer pessoa da equipe pode suspender uma PT.</p>
        </div>
        <button type="button" onClick={async () => { clearTenant(); await logout(); }}
          className="mt-3 flex min-h-[48px] w-full items-center gap-3 rounded-lg px-3 text-navy-text hover:bg-navy-hover hover:text-white">
          <LogOut aria-hidden size={20} /> Sair
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:pl-64">
      <aside aria-label="Menu" className="fixed inset-y-0 left-0 z-30 hidden w-64 overflow-y-auto bg-navy lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Fechar menu" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-navy">
            <button type="button" aria-label="Fechar menu" onClick={() => setOpen(false)}
              className="absolute right-2 top-2 flex h-12 w-12 items-center justify-center rounded-lg text-white hover:bg-navy-hover">
              <X aria-hidden size={22} />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex min-h-[64px] items-center gap-3 border-b border-line bg-surface px-4 lg:px-8">
        <button type="button" aria-label="Abrir menu" aria-expanded={open} onClick={() => setOpen(true)}
          className="-ml-2 flex h-12 w-12 items-center justify-center rounded-lg text-ink hover:bg-canvas lg:hidden">
          <Menu aria-hidden size={24} />
        </button>
        <div className="flex min-w-0 items-center gap-3">
          <Building2 aria-hidden size={20} className="hidden shrink-0 text-brand sm:block" />
          <div className="min-w-0">
            <p className="truncate font-semibold" title={session.tenant.name}>{session.tenant.name}</p>
            <p className="text-xs text-muted">Empresa ativa{others && <> · <a href="/empresa" className="underline">trocar</a></>}</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-right text-sm sm:block">
            <span className="block font-semibold">{session.me.user.displayName}</span>
            <span className="block text-xs text-muted">{session.me.user.email}</span>
          </span>
          <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-full border border-[#d1e1d5] bg-ok-bg text-sm font-bold text-ok">
            {initials(session.me.user.displayName)}
          </span>
        </div>
      </header>
      <main id="conteudo" className={`mx-auto flex flex-col gap-4 p-4 pb-24 lg:px-8 lg:py-6 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}>
        {children}
      </main>
    </div>
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
        <Button key={t.tenantId} variant="secondary" className="text-left" onClick={() => { setTenant(t.tenantId); router.replace('/painel'); }}>
          {t.name}
        </Button>
      ))}
    </div>
  );
}
