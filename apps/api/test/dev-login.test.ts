import { loadConfig } from '../src/config';

const base = { DATABASE_URL: 'postgresql://x@localhost/x', OIDC_ISSUER: 'https://idp.test/realms/x', OIDC_AUDIENCE: 'api' };

describe('login de teste (AUTH_MODE=dev)', () => {
  it('é desligado por padrão', () => {
    expect(loadConfig(base).AUTH_MODE).toBe('oidc');
  });
  it('é recusado em produção', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'dev', NODE_ENV: 'production' })).toThrow(/produção/);
  });
});
