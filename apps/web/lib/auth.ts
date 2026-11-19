'use client';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { API_URL, AUTH_MODE, OIDC_AUTHORITY, OIDC_CLIENT_ID } from './config';

let manager: UserManager | null = null;

/**
 * Login pelo provedor OIDC (Keycloak) com Authorization Code + PKCE.
 * O token fica no sessionStorage (some ao fechar a aba) e nunca em cookie
 * legível por outros sites. Nenhuma credencial do sistema vive no frontend.
 */
export function auth(): UserManager {
  if (!manager) {
    manager = new UserManager({
      authority: OIDC_AUTHORITY,
      client_id: OIDC_CLIENT_ID,
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}/entrar`,
      response_type: 'code',
      scope: 'openid profile email',
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      automaticSilentRenew: AUTH_MODE !== 'dev',
    });
  }
  return manager;
}

export async function currentUser(): Promise<User | null> {
  const u = await auth().getUser();
  return u && !u.expired ? u : null;
}

export async function accessToken(): Promise<string | null> {
  return (await currentUser())?.access_token ?? null;
}

/** Só aceita caminhos internos (evita redirecionamento para fora do site). */
export function safeReturnPath(p: unknown): string {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/painel';
}

/**
 * Pede ao provedor um login novo (para assinar com login recente) e volta para
 * a mesma tela depois.
 */
export async function reauthenticate(returnTo: string) {
  if (AUTH_MODE === 'dev') {
    const email = (await auth().getUser())?.profile.email;
    if (email) await devLogin(email);
    window.location.assign(safeReturnPath(returnTo));
    return;
  }
  return auth().signinRedirect({ prompt: 'login', max_age: 0, state: { returnTo: safeReturnPath(returnTo) } });
}

/** Usuários fictícios do seed, para o login de teste. */
export const DEV_USERS = [
  { email: 'admin@sitedopai.local', label: 'Ana — administradora da empresa' },
  { email: 'sst@sitedopai.local', label: 'Sérgio — SST' },
  { email: 'sst2@sitedopai.local', label: 'Silvia — SST e vigia (modo demonstração)' },
  { email: 'supervisor@sitedopai.local', label: 'Sueli — supervisora' },
  { email: 'executante@sitedopai.local', label: 'Edson — executante' },
  { email: 'plataforma@sitedopai.local', label: 'Paula — administradora da plataforma' },
];

/** Login de TESTE (AUTH_MODE=dev): a API emite o token sem Keycloak. */
export async function devLogin(email: string) {
  const r = await fetch(`${API_URL}/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error('login de teste indisponível');
  const { accessToken, expiresIn } = (await r.json()) as { accessToken: string; expiresIn: number };
  const now = Math.floor(Date.now() / 1000);
  await auth().storeUser(new User({
    access_token: accessToken, token_type: 'Bearer', scope: 'openid profile email',
    profile: { sub: `dev:${email}`, email, iss: OIDC_AUTHORITY, aud: OIDC_CLIENT_ID, exp: now + expiresIn, iat: now },
    expires_at: now + expiresIn,
  }));
}

export async function logout() {
  if (AUTH_MODE === 'dev') {
    await auth().removeUser();
    window.location.assign('/entrar');
    return;
  }
  await auth().signoutRedirect().catch(() => auth().removeUser().then(() => window.location.assign('/entrar')));
}
