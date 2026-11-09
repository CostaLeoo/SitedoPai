import { NextRequest, NextResponse } from 'next/server';

const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const idp = process.env.NEXT_PUBLIC_OIDC_AUTHORITY ?? 'http://localhost:8080/realms/sitedopai';

/**
 * CSP com nonce por requisição: só scripts do próprio Next (com o nonce) rodam.
 * Sem 'unsafe-inline' para scripts. Estilos inline continuam permitidos
 * (Tailwind e atributos style), o que não executa código.
 */
export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self'${api.startsWith('http') ? ` ${api}` : ''} ${new URL(idp).origin}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
