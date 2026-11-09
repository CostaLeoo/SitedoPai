import {
  BadRequestException, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { audit, Tx } from '@sitedopai/db';
import { MAX_PHOTO_BYTES, processPhoto } from '../apr/image';
import { Auth, RequirePermission, Tenant } from '../common/decorators';
import { notFound, requireUnit } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { uuid } from '../common/validation';
import { DbService } from '../db.service';
import { OBJECT_STORAGE, ObjectStorage } from '../storage/storage';

const EDITABLE = new Set(['DRAFT', 'RETURNED']);

@Controller('aprs/:id')
export class PhotosController {
  constructor(private readonly db: DbService, @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  private async apr(tx: Tx, t: TenantContext, id: string, p: 'apr.read' | 'apr.write' | 'apr.photo_original') {
    if (!uuid.safeParse(id).success) throw notFound('APR');
    const apr = await tx.selectFrom('aprs').select(['id', 'unit_id', 'status', 'revision', 'template_version_id']).where('id', '=', id).executeTakeFirst();
    if (!apr) throw notFound('APR');
    try {
      requireUnit(t, 'apr.read', apr.unit_id);
    } catch {
      throw notFound('APR');
    }
    if (p !== 'apr.read') requireUnit(t, p, apr.unit_id);
    return apr;
  }

  /**
   * Recebe uma foto para a pergunta. Grava o original intacto e a cópia de
   * exibição sem metadados; registra hash e horário do recebimento no servidor.
   */
  @Post('questions/:questionId/photos')
  @RequirePermission('apr.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 0 } }))
  async upload(
    @Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('questionId') questionId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!uuid.safeParse(questionId).success) throw notFound('Pergunta');
    if (!file) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Envie a foto no campo "file".' });
    const ctx = { tenantId: t.tenantId, userId: auth.userId };

    // Confere permissão, estado da APR e a pergunta antes de processar o arquivo.
    const pre = await this.db.run(ctx, async (tx) => {
      const apr = await this.apr(tx, t, id, 'apr.write');
      if (!EDITABLE.has(apr.status)) throw new BadRequestException({ code: 'APR_NOT_EDITABLE', message: 'A APR não está em edição.' });
      const q = await tx.selectFrom('apr_template_questions').select(['id', 'photos_max'])
        .where('id', '=', questionId).where('template_version_id', '=', apr.template_version_id).executeTakeFirst();
      if (!q) throw notFound('Pergunta');
      if (q.photos_max === 0) throw new BadRequestException({ code: 'PHOTOS_NOT_ALLOWED', message: 'Esta pergunta não recebe fotos.' });
      return apr;
    });

    const img = await processPhoto(file.buffer);
    if (!img.ok) throw new BadRequestException({ code: img.code, message: img.message });

    const photoId = randomUUID();
    const base = `tenants/${t.tenantId}/aprs/${id}/photos/${photoId}`;
    const originalKey = `${base}/original`;
    const displayKey = `${base}/display.jpg`;
    await this.storage.put(originalKey, file.buffer, img.mime);
    await this.storage.put(displayKey, img.display, 'image/jpeg');
    try {
      return await this.db.run(ctx, async (tx) => {
        const row = await tx.insertInto('apr_photos').values({
          id: photoId, tenant_id: t.tenantId, apr_id: id, question_id: questionId, apr_revision: pre.revision,
          original_key: originalKey, display_key: displayKey, mime_type: img.mime, size_bytes: file.size,
          sha256: img.sha256, width: img.width, height: img.height, uploaded_by: auth.userId,
        }).returning(['id', 'sha256', 'received_at', 'scan_status']).executeTakeFirstOrThrow();
        await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.photo_add', entityType: 'apr', entityId: id, data: { photoId, questionId, sha256: img.sha256, size: file.size } });
        return { id: row.id, sha256: row.sha256, receivedAt: row.received_at, scanStatus: row.scan_status };
      });
    } catch (err) {
      // Banco recusou (limite de fotos, APR mudou de estado): não deixa arquivo órfão.
      await Promise.allSettled([this.storage.remove(originalKey), this.storage.remove(displayKey)]);
      if ((err as { message?: string }).message?.includes('limite de fotos')) {
        throw new BadRequestException({ code: 'PHOTO_LIMIT', message: 'Esta pergunta já tem o número máximo de fotos.' });
      }
      throw err;
    }
  }

  @Get('photos/:photoId')
  @RequirePermission('apr.read')
  async display(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('photoId') photoId: string, @Res() res: Response) {
    const p = await this.photo(auth, t, id, photoId, 'apr.read');
    if (p.scan_status === 'REJECTED') throw notFound('Foto');
    this.send(res, await this.storage.get(p.display_key), 'image/jpeg');
  }

  /** Arquivo original, para conferência de integridade; perfis de revisão e auditoria. */
  @Get('photos/:photoId/original')
  @RequirePermission('apr.photo_original')
  async original(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('photoId') photoId: string, @Res() res: Response) {
    const p = await this.photo(auth, t, id, photoId, 'apr.photo_original');
    res.setHeader('X-Content-SHA256', p.sha256);
    this.send(res, await this.storage.get(p.original_key), p.mime_type, true);
  }

  /** Remove a foto antes do envio. O registro e os arquivos ficam preservados (remoção lógica). */
  @Delete('photos/:photoId')
  @HttpCode(204)
  @RequirePermission('apr.write')
  async remove(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Param('id') id: string, @Param('photoId') photoId: string) {
    if (!uuid.safeParse(photoId).success) throw notFound('Foto');
    await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      const apr = await this.apr(tx, t, id, 'apr.write');
      if (!EDITABLE.has(apr.status)) throw new BadRequestException({ code: 'APR_NOT_EDITABLE', message: 'A APR não está em edição.' });
      const r = await tx.updateTable('apr_photos').set({ removed_at: new Date(), removed_by: auth.userId })
        .where('id', '=', photoId).where('apr_id', '=', id).where('removed_at', 'is', null).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('Foto');
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'apr.photo_remove', entityType: 'apr', entityId: id, data: { photoId } });
    });
  }

  private async photo(auth: AuthContext, t: TenantContext, id: string, photoId: string, p: 'apr.read' | 'apr.photo_original') {
    if (!uuid.safeParse(photoId).success) throw notFound('Foto');
    return this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await this.apr(tx, t, id, p);
      const photo = await tx.selectFrom('apr_photos').select(['display_key', 'original_key', 'mime_type', 'sha256', 'scan_status'])
        .where('id', '=', photoId).where('apr_id', '=', id).where('removed_at', 'is', null).executeTakeFirst();
      if (!photo) throw notFound('Foto');
      return photo;
    });
  }

  private send(res: Response, body: Buffer, type: string, download = false) {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', download ? 'attachment; filename="original"' : 'inline');
    res.end(body);
  }
}
