import { Controller, Get, Header, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { audit, DocType, sql, Tx } from '@sitedopai/db';
import { canOnUnit } from '../authz/permissions';
import { Auth, Public, RequirePermission, Tenant } from '../common/decorators';
import { notFound, requireUnit } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { parse, uuid } from '../common/validation';
import { DbService } from '../db.service';
import { PtService } from '../pt/pt.service';
import { OBJECT_STORAGE, ObjectStorage } from '../storage/storage';
import { DocumentsService } from './documents.service';
import { z } from 'zod';

const READ = { apr: 'apr.read', work_permit: 'pt.read' } as const;
const LABEL = { apr: 'APR', work_permit: 'PT' } as const;

/** Confere que o documento existe e que o usuário o vê; senão, 404 (não revela existência). */
export async function scopedDocument(tx: Tx, t: TenantContext, type: DocType, id: string) {
  if (!uuid.safeParse(id).success) throw notFound(LABEL[type]);
  const row = type === 'apr'
    ? await tx.selectFrom('aprs').select(['id', 'unit_id']).where('id', '=', id).executeTakeFirst()
    : await tx.selectFrom('work_permits').select(['id', 'unit_id']).where('id', '=', id).executeTakeFirst();
  if (!row || !canOnUnit(t.assignments, READ[type], row.unit_id)) throw notFound(LABEL[type]);
  return row;
}

function present(d: { id: string; document_type: string; document_id: string; document_number: string; document_revision: number; sequence: number;
  status_at_issue: string; sha256: string; size_bytes: number; verification_code: string; issued_by: string; issued_at: Date }, issuer?: string) {
  return {
    id: d.id, documentType: d.document_type, documentId: d.document_id, documentNumber: d.document_number, documentRevision: d.document_revision,
    sequence: d.sequence, statusAtIssue: d.status_at_issue, sha256: d.sha256, sizeBytes: d.size_bytes, verificationCode: d.verification_code,
    issuedBy: issuer ?? d.issued_by, issuedAt: d.issued_at,
  };
}

@Controller()
export class DocumentsController {
  constructor(
    private readonly db: DbService,
    private readonly docs: DocumentsService,
    private readonly pts: PtService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private async issue(auth: AuthContext, t: TenantContext, type: DocType, id: string) {
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const row = await scopedDocument(tx, t, type, id);
      requireUnit(t, READ[type], row.unit_id);
      if (type === 'work_permit') await this.pts.syncExpiry(tx, t.tenantId);
      // Uma emissão por vez por documento: a sequência não pode repetir.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`doc:${id}`}))`.execute(tx);
      const d = await this.docs.issue(tx, t.tenantId, auth.userId, type, id);
      return { id: d.id, sequence: d.sequence, sha256: d.sha256, verificationCode: d.verification_code, issuedAt: d.issued_at };
    });
  }

  /** Emite o PDF da APR em qualquer situação; a situação fica impressa em destaque. */
  @Post('aprs/:id/documents')
  @RequirePermission('apr.read')
  issueApr(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.issue(auth, t, 'apr', id);
  }

  @Post('work-permits/:id/documents')
  @RequirePermission('pt.read')
  issuePt(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string) {
    return this.issue(auth, t, 'work_permit', id);
  }

  @Get('documents')
  @RequirePermission('apr.read')
  list(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Query() q: unknown) {
    const f = parse(z.object({ documentType: z.enum(['apr', 'work_permit']), documentId: z.string() }), q);
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await scopedDocument(tx, t, f.documentType, f.documentId);
      const rows = await tx.selectFrom('issued_documents').innerJoin('users', 'users.id', 'issued_documents.issued_by')
        .selectAll('issued_documents').select('users.display_name')
        .where('document_type', '=', f.documentType).where('document_id', '=', f.documentId).orderBy('sequence', 'desc').execute();
      return rows.map((r) => present(r, r.display_name));
    });
  }

  /** Baixa o PDF arquivado. Confere o hash antes de entregar e registra o download. */
  @Get('documents/:id/file')
  @RequirePermission('apr.read')
  async file(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Res() res: Response) {
    if (!uuid.safeParse(id).success) throw notFound('Documento');
    const { d, buf } = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const d = await tx.selectFrom('issued_documents').selectAll().where('id', '=', id).executeTakeFirst();
      if (!d) throw notFound('Documento');
      try {
        await scopedDocument(tx, t, d.document_type, d.document_id);
      } catch {
        throw notFound('Documento');
      }
      const buf = await this.storage.get(d.storage_key);
      if (createHash('sha256').update(buf).digest('hex') !== d.sha256) {
        throw new Error(`integridade: hash do arquivo arquivado não confere (${d.id})`);
      }
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'document.download', entityType: d.document_type, entityId: d.document_id, data: { documentId: d.id } });
      return { d, buf };
    });
    const name = `${d.document_number}${d.document_revision ? `-rev${d.document_revision}` : ''}-emissao${d.sequence}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  }
}

const STATUS_PT: Record<string, string> = {
  DRAFT: 'Rascunho', IN_ANALYSIS: 'Em análise', AWAITING_CORRECTION: 'Aguardando correção', AWAITING_APPROVAL: 'Aguardando liberação',
  RELEASED: 'Liberada', IN_EXECUTION: 'Em execução', SUSPENDED: 'Suspensa', EXPIRED: 'Expirada', CLOSED: 'Encerrada', CANCELLED: 'Cancelada',
  APPROVED: 'Aprovada', IN_REVIEW: 'Em revisão', RETURNED: 'Devolvida',
};

/**
 * Verificação pública pelo QR Code. Não exige login e por isso só devolve dados
 * sem informação pessoal: tipo, número, empresa, datas, hash e situação.
 */
@Controller('verify')
export class VerifyController {
  constructor(private readonly db: DbService) {}

  @Get(':code')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async verify(@Param('code') code: string) {
    const c = code.trim().toUpperCase();
    if (!/^[A-Z2-7]{24}$/.test(c)) throw notFound('Documento');
    const r = await this.db.run({}, async (tx) => (await sql<{
      document_type: string; document_number: string; document_revision: number; company: string; issued_at: Date; sha256: string;
      status_at_issue: string; current_status: string; valid_from: Date | null; valid_until: Date | null;
    }>`SELECT * FROM verify_document(${c})`.execute(tx)).rows[0]);
    if (!r) throw notFound('Documento');
    const isPt = r.document_type === 'work_permit';
    const authorizes = isPt ? ['RELEASED', 'IN_EXECUTION'].includes(r.current_status) && !!r.valid_until && new Date(r.valid_until) > new Date()
      && !!r.valid_from && new Date(r.valid_from) <= new Date() : r.current_status === 'APPROVED';
    return {
      documentType: r.document_type, documentNumber: r.document_number, documentRevision: r.document_revision, company: r.company,
      issuedAt: r.issued_at, sha256: r.sha256,
      statusAtIssue: r.status_at_issue, statusAtIssueText: STATUS_PT[r.status_at_issue] ?? r.status_at_issue,
      currentStatus: r.current_status, currentStatusText: STATUS_PT[r.current_status] ?? r.current_status,
      validFrom: r.valid_from, validUntil: r.valid_until,
      /** PT: autoriza agora? APR: aprovada? Nunca "sim" para PT suspensa, expirada, encerrada ou cancelada. */
      currentlyValid: authorizes,
      checkedAt: new Date(),
    };
  }
}
