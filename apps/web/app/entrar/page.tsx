'use client';
import { useState } from 'react';
import { Banner, Button } from '@/components/ui';
import { auth, DEV_USERS, devLogin, safeReturnPath } from '@/lib/auth';
import { AUTH_MODE } from '@/lib/config';

export default function Entrar() {
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="mx-auto flex min-h-dvh max-w-screen-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">SitedoPai</h1>
        <p className="mt-2 text-muted">Análise Preliminar de Riscos e Permissão de Trabalho.</p>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {AUTH_MODE === 'dev' ? (
        <>
          <Banner tone="warn">Modo de teste: escolha um usuário fictício. Sem senha e sem verificação em duas etapas.</Banner>
          <div className="flex flex-col gap-3">
            {DEV_USERS.map((u) => (
              <Button key={u.email} variant="secondary" onClick={() => devLogin(u.email)
                .then(() => window.location.assign(safeReturnPath(new URLSearchParams(window.location.search).get('returnTo'))))
                .catch(() => setError('A API não respondeu. Confira se ela está rodando com AUTH_MODE=dev.'))}>
                Entrar como {u.label}
              </Button>
            ))}
          </div>
        </>
      ) : <Button onClick={() => auth().signinRedirect().catch(() => setError('Não foi possível abrir o login. Confira a conexão e tente de novo.'))}>
        Entrar com sua conta
      </Button>}
      {AUTH_MODE !== 'dev' && <p className="text-sm text-muted">Perfis de administração, SST, supervisão e auditoria pedem a verificação em duas etapas.</p>}
    </main>
  );
}
