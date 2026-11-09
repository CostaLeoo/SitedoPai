import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from '@sitedopai/db';
import { PUBLIC } from '../common/decorators';
import type { AppRequest } from '../common/request';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db.service';
import { TokenVerifier } from './token-verifier';

/** Valida o token OIDC e resolve o usuário convidado correspondente. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9\-_.]+)$/.exec(header);
    if (!match) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Faça login para continuar.' });

    let token;
    try {
      token = await this.verifier.verify(match[1]!);
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sessão inválida ou expirada. Faça login novamente.' });
    }

    const r = await sql<{ id: string | null }>`
      SELECT auth_resolve_user(${token.subject}, ${token.email}, ${token.emailVerified}) AS id`.execute(this.db.db);
    const userId = r.rows[0]?.id;
    if (!userId) {
      throw new ForbiddenException({ code: 'NOT_INVITED', message: 'Seu acesso ainda não foi liberado por uma empresa.' });
    }
    req.auth = {
      userId,
      subject: token.subject,
      mfa: token.amr.some((v) => this.config.mfaAmrValues.includes(v)),
      amr: token.amr,
      authTime: token.authTime,
      sessionId: token.sessionId,
      tokenId: token.tokenId,
      ip: req.ip ?? '',
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };
    return true;
  }
}
