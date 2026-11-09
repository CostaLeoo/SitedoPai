'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { auth } from '@/lib/auth';

export default function Callback() {
  const router = useRouter();
  const [error, setError] = useState(false);
  useEffect(() => {
    auth().signinRedirectCallback().then(() => router.replace('/aprs')).catch(() => setError(true));
  }, [router]);
  return (
    <main className="mx-auto max-w-screen-sm p-6">
      {error ? <Banner tone="danger" title="Login não concluído"><a className="underline" href="/entrar">Tentar de novo</a></Banner> : <p>Entrando…</p>}
    </main>
  );
}
