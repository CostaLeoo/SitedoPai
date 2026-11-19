import { FileCheck2, LockKeyhole, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';

/** Página de entrada em duas colunas (identidade inspirada no Vigia). */
export function BrandLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="flex flex-col justify-between gap-10 bg-navy px-6 py-6 text-white sm:px-10 lg:px-14 lg:py-12" aria-label="Vigia">
        <div className="flex items-center gap-3">
          <ShieldCheck aria-hidden size={34} className="text-mint" />
          <span>
            <strong className="block text-3xl font-bold tracking-tight">Vigia</strong>
            <span className="block text-[0.65rem] uppercase tracking-[0.15em] text-navy-text">segurança operacional</span>
          </span>
        </div>
        <div className="hidden max-w-xl lg:block">
          <span className="mb-4 block text-xs font-bold uppercase tracking-[0.2em] text-mint">APR &amp; Permissão de Trabalho</span>
          <p className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">Segurança em<br />cada etapa.</p>
          <p className="mt-5 text-lg text-navy-text">Analise riscos em campo, libere com responsáveis claros e suspenda na hora quando a condição mudar.</p>
        </div>
        <ul className="hidden flex-wrap gap-x-8 gap-y-3 text-sm text-navy-text lg:flex">
          <li className="flex items-center gap-2"><FileCheck2 aria-hidden size={18} className="text-mint" /> Rastreabilidade</li>
          <li className="flex items-center gap-2"><Users aria-hidden size={18} className="text-mint" /> Responsabilidade</li>
          <li className="flex items-center gap-2"><LockKeyhole aria-hidden size={18} className="text-mint" /> Acesso controlado</li>
        </ul>
      </section>
      <main id="conteudo" className="flex items-center justify-center bg-canvas px-6 py-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
