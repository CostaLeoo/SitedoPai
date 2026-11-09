export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
export const OIDC_AUTHORITY = process.env.NEXT_PUBLIC_OIDC_AUTHORITY ?? 'http://localhost:8080/realms/sitedopai';
export const OIDC_CLIENT_ID = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? 'sitedopai-web';
/** 'dev' = login de teste sem Keycloak (lista de usuários fictícios). */
export const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE === 'dev' ? 'dev' : 'oidc';
