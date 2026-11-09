import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, JWTVerifyGetKey, jwtVerify } from 'jose';
import { APP_CONFIG, AppConfig } from '../config';

export interface VerifiedToken {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  amr: string[];
  /** Momento do login (claim auth_time), em segundos. */
  authTime: number | null;
  sessionId: string | null;
  tokenId: string | null;
}

export const TOKEN_KEYS = Symbol('TOKEN_KEYS');

/** Chaves públicas do provedor OIDC (Keycloak). Substituídas nos testes. */
export function remoteKeys(config: AppConfig): JWTVerifyGetKey {
  const url = config.OIDC_JWKS_URL ?? `${config.OIDC_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/certs`;
  return createRemoteJWKSet(new URL(url));
}

@Injectable()
export class TokenVerifier {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TOKEN_KEYS) private readonly keys: JWTVerifyGetKey,
  ) {}

  /** Lança erro se a assinatura, o emissor, o público ou a validade não conferem. */
  async verify(token: string): Promise<VerifiedToken> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.config.OIDC_ISSUER,
      audience: this.config.OIDC_AUDIENCE,
      algorithms: ['RS256', 'ES256', 'PS256'],
      clockTolerance: 5,
    });
    if (!payload.sub) throw new Error('token sem sub');
    const amr = Array.isArray(payload.amr) ? payload.amr.filter((v): v is string => typeof v === 'string') : [];
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: payload.email_verified === true,
      amr,
      authTime: typeof payload.auth_time === 'number' ? payload.auth_time : null,
      sessionId: typeof payload.sid === 'string' ? payload.sid : null,
      tokenId: typeof payload.jti === 'string' ? payload.jti : null,
    };
  }
}
