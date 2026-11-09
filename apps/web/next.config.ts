import type { NextConfig } from 'next';

// Opcional: o site repassa /api/* para a API (mesma origem no navegador).
// Usado no Codespaces, onde só a porta do site fica acessível.
const proxy = process.env.API_PROXY_TARGET;

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(proxy ? { async rewrites() { return [{ source: '/api/:path*', destination: `${proxy.replace(/\/$/, '')}/:path*` }]; } } : {}),
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        // A CSP (com nonce por requisição) é definida em middleware.ts.
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(), microphone=()' },
      ],
    }];
  },
};

export default config;
