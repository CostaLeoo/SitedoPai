import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = { title: 'Vigia — APR e Permissão de Trabalho' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#111827' };

// Renderização por requisição: necessária para o Next aplicar o nonce da CSP aos scripts.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
