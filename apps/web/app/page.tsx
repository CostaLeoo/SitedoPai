'use client';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { BrandLayout } from '@/components/brand-panel';
import { currentUser } from '@/lib/auth';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    currentUser().then((u) => u && router.replace('/painel'));
  }, [router]);
  return (
    <BrandLayout>
      <h1 className="text-2xl font-bold tracking-tight">Bem-vindo</h1>
      <p className="mt-2 text-muted">Entre para ver as APRs e Permissões de Trabalho da sua empresa.</p>
      <a href="/entrar" className="mt-6 inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-lg bg-brand px-5 text-lg font-semibold text-white hover:bg-brand-ink">
        Entrar na plataforma <ArrowRight aria-hidden size={20} />
      </a>
      <p className="mt-6 rounded-lg border border-line bg-info-bg p-4 text-sm text-info">
        Ambiente em homologação. Ainda não substitui o processo de autorização da sua empresa.
      </p>
    </BrandLayout>
  );
}
