import type { NextConfig } from 'next';

const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const idp = process.env.NEXT_PUBLIC_OIDC_AUTHORITY ?? 'http://localhost:8080/realms/sitedopai';

const csp = [
  "default-src 'self'",
  // Next injeta scripts inline de hidratação; nonce entra junto com a implantação.
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data:`,
  `connect-src 'self' ${api} ${new URL(idp).origin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(), microphone=()' },
      ],
    }];
  },
};

export default config;
