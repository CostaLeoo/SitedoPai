import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWTVerifyGetKey, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Public } from '../common/decorators';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * Login de TESTE, sem Keycloak. Só existe com AUTH_MODE=dev, e a configuração
 * recusa esse modo quando NODE_ENV=production. Aceita apenas os usuários
 * fictícios do domínio @sitedopai.local criados pelo seed.
 */
export const DEV_SIGNER = Symbol('DEV_SIGNER');
export interface DevSigner {
  keys: JWTVerifyGetKey;
  sign(email: string): Promise<string>;
}

export async function createDevSigner(config: AppConfig): Promise<DevSigner> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'RS256' };
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    async sign(email) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email, email_verified: true, amr: ['pwd', 'otp'], auth_time: now, sid: randomUUID() })
        .setProtectedHeader({ alg: 'RS256', kid: 'dev' })
        .setSubject(`dev:${email}`).setIssuer(config.OIDC_ISSUER).setAudience(config.OIDC_AUDIENCE)
        .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 8 * 3600).sign(privateKey);
    },
  };
}

const body = z.object({ email: z.string().regex(/^[a-z0-9._-]+@sitedopai\.local$/) });

@Controller('dev')
export class DevLoginController {
  constructor(@Inject(DEV_SIGNER) private readonly signer: DevSigner, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body() b: unknown) {
    const p = body.safeParse(b);
    if (!p.success) throw new BadRequestException({ code: 'DEV_EMAIL', message: 'Use um usuário fictício @sitedopai.local.' });
    return { accessToken: await this.signer.sign(p.data.email), expiresIn: 8 * 3600 };
  }
}
