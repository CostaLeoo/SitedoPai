import { Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { zipSync, Zippable } from 'fflate';
import { createHash } from 'node:crypto';
import { audit } from '@sitedopai/db';
import { AprService } from '../apr/apr.service';
import { AllowWhenRestricted, Auth, RequirePermission, Tenant } from '../common/decorators';
import { requireTenantWide } from '../common/guards';
import type { AuthContext, TenantContext } from '../common/request';
import { DbService } from '../db.service';
import { PtService } from '../pt/pt.service';
import { OBJECT_STORAGE, ObjectStorage } from '../storage/storage';

const csvCell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
  // Evita fórmula ao abrir no Excel (injeção CSV).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]!);
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))].join('\r\n') + '\r\n';
};
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };

const README = `EXPORTAÇÃO DE DADOS — Vigia

Conteúdo:
- dados/*.json: dados completos em JSON (UTF-8).
- dados/*.csv: resumos para planilha (separador ";", UTF-8 com BOM).
- documentos/: todos os PDFs emitidos, exatamente como foram arquivados.
- fotos/: arquivos ORIGINAIS das fotos das APRs, como foram recebidos.
- manifesto.json: lista de todos os arquivos com hash SHA-256, para conferir
  a integridade depois da cópia.

A exportação não apaga nada no sistema. A guarda legal dos documentos continua
sendo responsabilidade da empresa, conforme as regras de guarda cadastradas.
`;

/**
 * Exportação completa da empresa (fim de contrato ou a qualquer momento).
 * Disponível mesmo com a conta somente leitura ou encerrada.
 */
@Controller('exports')
export class ExportController {
  constructor(
    private readonly db: DbService,
    private readonly aprs: AprService,
    private readonly pts: PtService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post()
  @HttpCode(200)
  @AllowWhenRestricted()
  @RequirePermission('tenant.export')
  async export(@Auth() auth: AuthContext, @Tenant() t: TenantContext, @Res() res: Response) {
    requireTenantWide(t, 'tenant.export');
    const files: Record<string, Uint8Array> = {};
    const enc = new TextEncoder();
    const json = (path: string, v: unknown) => (files[path] = enc.encode(JSON.stringify(v, null, 2)));
    const generatedAt = new Date();

    const tenant = await this.db.run({ tenantId: t.tenantId, userId: auth.userId }, async (tx) => {
      await this.pts.syncExpiry(tx, t.tenantId);
      const tenant = await tx.selectFrom('tenants').selectAll().where('id', '=', t.tenantId).executeTakeFirstOrThrow();
      json('dados/empresa.json', tenant);
      json('dados/unidades.json', await tx.selectFrom('units').selectAll().execute());
      json('dados/setores.json', await tx.selectFrom('sectors').selectAll().execute());
      json('dados/terceirizadas.json', await tx.selectFrom('contractors').selectAll().execute());
      json('dados/usuarios.json', await tx.selectFrom('memberships').innerJoin('users', 'users.id', 'memberships.user_id')
        .select(['memberships.id', 'memberships.status', 'users.email', 'users.display_name', 'memberships.created_at']).execute());
      json('dados/papeis.json', await tx.selectFrom('role_assignments').selectAll().execute());
      json('dados/trabalhadores.json', await tx.selectFrom('workers').selectAll().execute());
      json('dados/qualificacoes.json', await tx.selectFrom('worker_qualifications').selectAll().execute());
      json('dados/matrizes-de-risco.json', await tx.selectFrom('risk_matrices').selectAll().execute());
      json('dados/modelos-apr.json', {
        modelos: await tx.selectFrom('apr_templates').selectAll().execute(),
        versoes: await tx.selectFrom('apr_template_versions').selectAll().execute(),
        perguntas: await tx.selectFrom('apr_template_questions').selectAll().execute(),
      });
      json('dados/tipos-de-pt.json', await tx.selectFrom('pt_types').selectAll().execute());

      const aprIds = await tx.selectFrom('aprs').select('id').orderBy('number').orderBy('revision').execute();
      const aprs = [];
      for (const { id } of aprIds) aprs.push(await this.aprs.loadFull(tx, id));
      json('dados/aprs.json', aprs);
      files['dados/aprs.csv'] = enc.encode(csv(aprs.map((f) => ({
        numero: f.apr.number, revisao: f.apr.revision, situacao: f.apr.status, data_atividade: f.apr.activity_date, local: f.apr.location,
        servico: f.apr.service_description, criada_em: f.apr.created_at, decidida_em: f.apr.decided_at,
      }))));

      const ptIds = await tx.selectFrom('work_permits').select('id').orderBy('number').execute();
      const pts = [];
      for (const { id } of ptIds) pts.push(await this.pts.loadFull(tx, id));
      json('dados/pts.json', pts);
      files['dados/pts.csv'] = enc.encode(csv(pts.map((f) => ({
        numero: f.pt.number, tipo: f.type.name, situacao: f.pt.status, apr: f.apr.number, local: f.pt.location, atividade: f.pt.description,
        inicio: f.pt.starts_at, fim: f.pt.ends_at, liberada_em: f.pt.released_at, encerrada_em: f.pt.closed_at,
      }))));
      json('dados/assinaturas.json', {
        assinaturas: await tx.selectFrom('signatures').selectAll().execute(),
        conteudos_assinados: await tx.selectFrom('document_snapshots').selectAll().execute(),
      });
      json('dados/regras-de-guarda.json', { regras: await tx.selectFrom('retention_rules').selectAll().execute(), retencoes: await tx.selectFrom('legal_holds').selectAll().execute() });
      json('dados/auditoria.json', await tx.selectFrom('audit_events').selectAll().orderBy('seq').execute());

      const issued = await tx.selectFrom('issued_documents').selectAll().orderBy('issued_at').execute();
      json('dados/documentos-emitidos.json', issued);
      for (const d of issued) {
        const buf = await this.storage.get(d.storage_key);
        if (createHash('sha256').update(buf).digest('hex') !== d.sha256) throw new Error(`integridade: PDF ${d.id} não confere`);
        files[`documentos/${safeName(`${d.document_number}${d.document_revision ? `-rev${d.document_revision}` : ''}-emissao${d.sequence}`)}.pdf`] = buf;
      }
      const photos = await tx.selectFrom('apr_photos').innerJoin('aprs', 'aprs.id', 'apr_photos.apr_id')
        .select(['apr_photos.id', 'apr_photos.original_key', 'apr_photos.mime_type', 'apr_photos.sha256', 'aprs.number', 'aprs.revision']).execute();
      for (const p of photos) {
        const buf = await this.storage.get(p.original_key);
        files[`fotos/${safeName(`${p.number}${p.revision ? `-rev${p.revision}` : ''}`)}/${p.id}.${EXT[p.mime_type] ?? 'bin'}`] = buf;
      }
      await audit(tx, t.tenantId, { actorUserId: auth.userId, action: 'tenant.export', entityType: 'tenant', entityId: t.tenantId,
        data: { aprs: aprs.length, pts: pts.length, documents: issued.length, photos: photos.length } });
      return tenant;
    });

    files['LEIA-ME.txt'] = enc.encode(README);
    const manifest = Object.entries(files).map(([path, data]) => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }));
    files['manifesto.json'] = enc.encode(JSON.stringify({ empresa: tenant.legal_name, cnpj: tenant.cnpj, geradoEm: generatedAt.toISOString(), arquivos: manifest }, null, 2));
    const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: k.startsWith('fotos/') || k.endsWith('.pdf') ? 0 : 6 }]])) as Zippable);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="exportacao-${tenant.cnpj}-${generatedAt.toISOString().slice(0, 10)}.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-SHA256', createHash('sha256').update(zip).digest('hex'));
    res.send(Buffer.from(zip));
  }
}
