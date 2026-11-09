'use client';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { OIDC_AUTHORITY, OIDC_CLIENT_ID } from './config';

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
      automaticSilentRenew: true,
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
