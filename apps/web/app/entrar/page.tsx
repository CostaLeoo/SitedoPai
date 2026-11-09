'use client';
import { useState } from 'react';
import { Banner, Button } from '@/components/ui';
import { auth } from '@/lib/auth';

export default function Entrar() {
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="mx-auto flex min-h-dvh max-w-screen-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">SitedoPai</h1>
        <p className="mt-2 text-muted">Análise Preliminar de Riscos e Permissão de Trabalho.</p>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      <Button onClick={() => auth().signinRedirect().catch(() => setError('Não foi possível abrir o login. Confira a conexão e tente de novo.'))}>
        Entrar com sua conta
      </Button>
      <p className="text-sm text-muted">Perfis de administração, SST, supervisão e auditoria pedem a verificação em duas etapas.</p>
    </main>
  );
}
