import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Tx } from '@sitedopai/db';
import { APP_CONFIG, AppConfig } from '../config';
import type { AuthContext } from './request';

/** JSON canônico: chaves ordenadas, datas em ISO. Mesmo conteúdo → mesmo hash. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface SignInput {
  documentType: string;
  documentId: string;
  content: unknown;
  meaning: string;
  signerName: string;
  context: Record<string, unknown>;
}

/**
 * Assinatura eletrônica avançada própria (decisão 1c, provisória até o parecer
 * jurídico): vincula a pessoa autenticada no provedor OIDC, com as evidências da
 * autenticação, ao hash do conteúdo exato. A assinatura desenhada na tela, se
 * houver, é só interface e não é registrada como prova.
 */
@Injectable()
export class SignatureService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Assinar exige login recente; atos privilegiados exigem também o segundo fator. */
  requireFreshAuth(auth: AuthContext, opts: { mfa: boolean }) {
    if (opts.mfa && !auth.mfa) {
      throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Esta assinatura exige a verificação em duas etapas.' });
    }
    const age = auth.authTime == null ? Infinity : Date.now() / 1000 - auth.authTime;
    if (age > this.config.SIGNATURE_MAX_AUTH_AGE_SECONDS) {
      throw new UnauthorizedException({ code: 'REAUTH_REQUIRED', message: 'Para assinar, confirme sua identidade entrando de novo.' });
    }
  }

  async sign(tx: Tx, tenantId: string, auth: AuthContext, input: SignInput): Promise<{ signatureId: string; hash: string }> {
    const content = canonicalJson(input.content);
    const hash = sha256(content);
    const snap = await tx.insertInto('document_snapshots')
      .values({ tenant_id: tenantId, document_type: input.documentType, document_id: input.documentId, content, hash })
      .returning('id').executeTakeFirstOrThrow();
    const sig = await tx.insertInto('signatures').values({
      tenant_id: tenantId, document_type: input.documentType, document_id: input.documentId, snapshot_id: snap.id,
      document_hash: hash, meaning: input.meaning, signer_user_id: auth.userId, signer_name: input.signerName,
      signer_context: JSON.stringify(input.context),
      evidence: JSON.stringify({
        method: 'OIDC_SESSION', mfa: auth.mfa, amr: auth.amr, authTime: auth.authTime, sessionId: auth.sessionId,
        tokenId: auth.tokenId, ip: auth.ip, userAgent: auth.userAgent,
      }),
    }).returning('id').executeTakeFirstOrThrow();
    return { signatureId: sig.id, hash };
  }
}
