import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { audit, DocType, GasParameter, TeamMember, Tx } from '@sitedopai/db';
import { AprService } from '../apr/apr.service';
import { classify, isMismatch } from '../apr/rules';
import { APP_CONFIG, AppConfig } from '../config';
import { PtService, STATUS_TEXT } from '../pt/pt.service';
import { FUNCTION_LABEL } from '../pt/rules';
import { OBJECT_STORAGE, ObjectStorage } from '../storage/storage';
import { formatDate, formatDateTime, IssueContext, Pdf } from './pdf';

const ANSWER: Record<string, string> = { YES: 'Sim', NO: 'Não', NA: 'N/A' };
const APR_STATUS: Record<string, string> = { DRAFT: 'Rascunho', IN_REVIEW: 'Em revisão', RETURNED: 'Devolvida', APPROVED: 'Aprovada', CANCELLED: 'Cancelada' };
const CONTROL: Record<string, string> = { ELIMINATION: 'Eliminação', SUBSTITUTION: 'Substituição', ENGINEERING: 'Engenharia/coletiva', ADMINISTRATIVE: 'Administrativa', PPE: 'EPI' };
const MEANING: Record<string, string> = { RELEASE: 'Liberação', RESUME: 'Retomada', ACKNOWLEDGE: 'Ciência dos riscos', SUSPEND: 'Suspensão', CLOSE: 'Encerramento' };
const ptStatus = (s: string) => STATUS_TEXT[s] ? STATUS_TEXT[s]!.charAt(0).toUpperCase() + STATUS_TEXT[s]!.slice(1) : s;

/** Código de verificação: 120 bits aleatórios em base32 (24 caracteres). */
export function newVerificationCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly aprs: AprService,
    private readonly pts: PtService,
  ) {}

  private async names(tx: Tx, ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = list.length ? await tx.selectFrom('users').select(['id', 'display_name']).where('id', 'in', list).execute() : [];
    const map = new Map(rows.map((r) => [r.id, r.display_name]));
    return (id: string | null | undefined) => (id ? map.get(id) ?? '—' : '—');
  }

  private async context(tx: Tx, tenantId: string, unitId: string, title: string, number: string, status: string, warning: string | null, issuerId: string, code: string) {
    const t = await tx.selectFrom('tenants').select(['legal_name', 'cnpj']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const u = await tx.selectFrom('units').select(['name', 'code']).where('id', '=', unitId).executeTakeFirstOrThrow();
    const issuer = await tx.selectFrom('users').select('display_name').where('id', '=', issuerId).executeTakeFirstOrThrow();
    const verifyUrl = `${this.config.PUBLIC_VERIFY_BASE_URL.replace(/\/$/, '')}/v/${code}`;
    const ctx: IssueContext = {
      title, documentNumber: number, company: { legalName: t.legal_name, cnpj: t.cnpj, unit: `${u.name} (${u.code})` },
      issuedAt: new Date(), issuedBy: issuer.display_name, verificationCode: code, verifyUrl,
      qrPng: await QRCode.toBuffer(verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 300 }), statusAtIssue: status, warning,
    };
    return ctx;
  }

  async renderApr(tx: Tx, tenantId: string, aprId: string, issuerId: string, code: string): Promise<{ pdf: Buffer; number: string; revision: number; status: string }> {
    const f = await this.aprs.loadFull(tx, aprId);
    const a = f.apr;
    const label = APR_STATUS[a.status] ?? a.status;
    const warning = a.status === 'APPROVED' ? null : `APR ${label.toUpperCase()}: NÃO AUTORIZA A EXECUÇÃO DA ATIVIDADE`;
    const ctx = await this.context(tx, tenantId, a.unit_id, 'Análise Preliminar de Riscos', `${a.number}${a.revision ? ` · revisão ${a.revision}` : ''}`, label, warning, issuerId, code);
    const name = await this.names(tx, [a.created_by, a.decided_by, a.submitted_by, ...f.answers.flatMap((x) => [x.answered_by, x.reassessed_by]), ...f.photos.map((p) => p.uploaded_by)]);
    const pv = f.template.professional_validation as unknown as { name: string; registry: string } | null;
    const p = new Pdf(ctx);

    p.h2('Identificação');
    p.fields([
      ['Data da atividade', formatDate(a.activity_date)], ['Local', a.location], ['Serviço', a.service_description],
      ['Responsável', a.responsible_name], ['Equipe', (a.team as unknown as TeamMember[]).map((m) => m.name).join(', ')],
      ['Equipamentos', (a.equipment as unknown as string[]).join(', ')],
      ['Modelo', `${f.template.name} (versão ${f.template.version})${pv ? ` — validado por ${pv.name}, ${pv.registry}` : ''}`],
      ['Matriz de risco', `${f.matrix.name} (versão ${f.matrix.version})`],
      ['Criada por', `${name(a.created_by)} em ${formatDateTime(a.created_at)}`],
      ['Enviada por', a.submitted_by ? `${name(a.submitted_by)} em ${formatDateTime(a.submitted_at)}` : null],
      [a.status === 'APPROVED' ? 'Aprovada por' : 'Decisão', a.decided_by ? `${name(a.decided_by)} em ${formatDateTime(a.decided_at)}${a.decision_note ? ` — ${a.decision_note}` : ''}` : null],
    ]);

    p.h2('Checklist');
    p.table(
      [{ header: '#', width: 4 }, { header: 'Pergunta', width: 36 }, { header: 'Resposta', width: 9 }, { header: 'Esperada', width: 9 },
        { header: 'Justificativa / ação corretiva', width: 28 }, { header: 'Nova avaliação', width: 14 }],
      f.questions.map((q) => {
        const ans = f.answers.find((x) => x.question_id === q.id);
        const flag = ans && isMismatch({ expectedAnswer: q.expected_answer, allowNa: q.allow_na }, ans.answer) ? ' (divergente)' : '';
        return [
          q.position, `${q.text}${q.criticality === 'CRITICAL' ? ' [CRÍTICA]' : ''}${q.normative_ref ? ` — ${q.normative_ref}` : ''}`,
          ans ? `${ANSWER[ans.answer]}${flag}` : 'Sem resposta', ANSWER[q.expected_answer],
          [ans?.justification && `Justificativa: ${ans.justification}`, ans?.corrective_action && `Ação: ${ans.corrective_action}`].filter(Boolean).join('\n'),
          ans?.reassessed_answer ? `${ANSWER[ans.reassessed_answer]} por ${name(ans.reassessed_by)}` : null,
        ];
      }),
    );

    p.h2('Análise de riscos');
    const rows = f.steps.flatMap((s) => f.hazards.filter((h) => h.step_id === s.id).map((h) => {
      const ini = classify(f.matrix, h.probability, h.severity);
      const res = classify(f.matrix, h.residual_probability, h.residual_severity);
      const controls = f.controls.filter((c) => c.hazard_id === h.id)
        .map((c) => `• ${c.description} (${CONTROL[c.control_type]}${c.responsible_name ? `; resp.: ${c.responsible_name}` : ''}${c.verified ? '; verificada' : ''})`).join('\n');
      return [`${s.position}. ${s.description}`, h.hazard, h.consequence, ini ? `${ini.class?.label ?? '?'} (${ini.score})` : null, controls, res ? `${res.class?.label ?? '?'} (${res.score})` : null];
    }));
    p.table([{ header: 'Etapa', width: 16 }, { header: 'Perigo', width: 14 }, { header: 'Consequência', width: 14 }, { header: 'Risco inicial', width: 10 },
      { header: 'Medidas de controle', width: 34 }, { header: 'Risco residual', width: 10 }], rows.length ? rows : [['Sem análise registrada', null, null, null, null, null]]);

    if (f.photos.length) {
      p.h2('Evidências fotográficas');
      p.para('Cópias de exibição, sem metadados. O arquivo original de cada foto fica preservado; o hash SHA-256 abaixo é o do original.', { muted: true, size: 8.5 });
      for (const ph of f.photos) {
        const q = f.questions.find((x) => x.id === ph.question_id);
        const disp = await tx.selectFrom('apr_photos').select('display_key').where('id', '=', ph.id).executeTakeFirstOrThrow();
        p.image(await this.storage.get(disp.display_key),
          `Pergunta ${q?.position ?? '?'} · recebida em ${formatDateTime(ph.received_at)} por ${name(ph.uploaded_by)} · SHA-256 ${ph.sha256}`);
      }
    }
    return { pdf: await p.finish(), number: a.number, revision: a.revision, status: a.status };
  }

  async renderPt(tx: Tx, tenantId: string, ptId: string, issuerId: string, code: string): Promise<{ pdf: Buffer; number: string; revision: number; status: string }> {
    const f = await this.pts.loadFull(tx, ptId);
    const pt = f.pt;
    const valid = this.pts.validity(pt);
    const warning = valid.valid ? null : `NÃO VALE COMO AUTORIZAÇÃO NA EMISSÃO: ${valid.reason}`;
    const ctx = await this.context(tx, tenantId, pt.unit_id, 'Permissão de Trabalho', pt.number, ptStatus(pt.status), warning, issuerId, code);
    const sigUsers = await tx.selectFrom('signatures').select(['meaning', 'signer_name', 'signed_at', 'document_hash'])
      .where('document_type', '=', 'work_permit').where('document_id', '=', ptId).orderBy('signed_at').execute();
    const name = await this.names(tx, [pt.created_by, pt.reviewed_by, pt.released_by, pt.closed_by, ...f.answers.flatMap((x) => [x.answered_by, x.reassessed_by]), ...f.measurements.map((m) => m.measured_by)]);
    const pv = f.type.professional_validation as unknown as { name: string; registry: string } | null;
    const p = new Pdf(ctx);

    p.h2('Identificação');
    p.fields([
      ['Tipo de PT', `${f.type.name} (versão ${f.type.version})${pv ? ` — validado por ${pv.name}, ${pv.registry}` : ''}`],
      ['APR vinculada', `${f.apr.number}${f.apr.revision ? ` revisão ${f.apr.revision}` : ''}`],
      ['Local', pt.location], ['Atividade', pt.description],
      ['Período autorizado', `${formatDateTime(pt.starts_at)} até ${formatDateTime(pt.ends_at)}`],
      ['Criada por', `${name(pt.created_by)} em ${formatDateTime(pt.created_at)}`],
      ['Análise técnica', pt.reviewed_by ? `${name(pt.reviewed_by)} em ${formatDateTime(pt.reviewed_at)}` : null],
      ['Liberada por', pt.released_by ? `${name(pt.released_by)} em ${formatDateTime(pt.released_at)}` : null],
      ['Encerrada por', pt.closed_by ? `${name(pt.closed_by)} em ${formatDateTime(pt.closed_at)}${pt.closing_notes ? ` — ${pt.closing_notes}` : ''}` : null],
      ['Motivo da situação', pt.status_reason],
    ]);

    p.h2('Equipe');
    p.table([{ header: 'Nome', width: 40 }, { header: 'Função', width: 30 }, { header: 'Ciência dos riscos', width: 30 }],
      f.team.map((m) => [m.full_name, FUNCTION_LABEL[m.function], m.acknowledged_signature_id ? 'Assinada' : 'Pendente']));

    p.h2('Checklist');
    p.table([{ header: '#', width: 4 }, { header: 'Pergunta', width: 44 }, { header: 'Resposta', width: 12 }, { header: 'Justificativa / ação', width: 26 }, { header: 'Nova avaliação', width: 14 }],
      f.questions.map((q) => {
        const ans = f.answers.find((x) => x.question_id === q.id);
        return [q.position, q.text, ans ? ANSWER[ans.answer] : 'Sem resposta',
          [ans?.justification, ans?.corrective_action && `Ação: ${ans.corrective_action}`].filter(Boolean).join('\n'),
          ans?.reassessed_answer ? `${ANSWER[ans.reassessed_answer]} por ${name(ans.reassessed_by)}` : null];
      }));

    if (f.type.requires_gas_monitoring) {
      const params = f.type.gas_parameters as unknown as GasParameter[];
      p.h2('Monitoramento atmosférico');
      p.para(`Limites configurados pelo SST: ${params.map((g) => `${g.label} ${[g.min !== undefined ? `≥ ${g.min}` : '', g.max !== undefined ? `≤ ${g.max}` : ''].filter(Boolean).join(' e ')} ${g.unit}`).join('; ')}. Validade de cada medição: ${f.type.gas_max_age_minutes} min.`, { muted: true, size: 8.5 });
      p.table([{ header: 'Data e hora', width: 26 }, { header: 'Parâmetro', width: 18 }, { header: 'Valor', width: 12 }, { header: 'Situação', width: 14 }, { header: 'Instrumento', width: 18 }, { header: 'Medido por', width: 16 }],
        f.measurements.map((m) => [formatDateTime(m.received_at), params.find((g) => g.key === m.parameter_key)?.label ?? m.parameter_key,
          `${Number(m.value).toLocaleString('pt-BR')} ${m.unit}`, m.within_limits ? 'Dentro do limite' : 'FORA DO LIMITE', m.instrument, name(m.measured_by)]));
    }

    if (f.type.requires_entry_log) {
      p.h2('Entradas e saídas');
      p.table([{ header: 'Pessoa', width: 40 }, { header: 'Entrada', width: 30 }, { header: 'Saída', width: 30 }],
        f.entries.length ? f.entries.map((e) => [e.full_name, formatDateTime(e.entered_at), e.exited_at ? formatDateTime(e.exited_at) : 'SEM SAÍDA REGISTRADA']) : [['Nenhuma entrada registrada', null, null]]);
    }

    p.h2('Assinaturas eletrônicas');
    p.para('Assinatura eletrônica avançada: pessoa autenticada no provedor de identidade, com login recente (e verificação em duas etapas para liberar e retomar). O hash identifica o conteúdo exato assinado.', { muted: true, size: 8.5 });
    p.table([{ header: 'Ato', width: 16 }, { header: 'Assinante', width: 24 }, { header: 'Data e hora', width: 24 }, { header: 'Hash do conteúdo (SHA-256)', width: 36 }],
      sigUsers.map((s) => [MEANING[s.meaning] ?? s.meaning, s.signer_name, formatDateTime(s.signed_at), s.document_hash]));
    return { pdf: await p.finish(), number: pt.number, revision: 0, status: pt.status };
  }

  /**
   * Emite: gera o PDF, grava no armazenamento em modo "gravar uma vez" e registra
   * a emissão (imutável) com hash e código de verificação.
   */
  async issue(tx: Tx, tenantId: string, issuerId: string, type: DocType, id: string) {
    const code = newVerificationCode();
    const r = type === 'apr' ? await this.renderApr(tx, tenantId, id, issuerId, code) : await this.renderPt(tx, tenantId, id, issuerId, code);
    const sha256 = createHash('sha256').update(r.pdf).digest('hex');
    const last = await tx.selectFrom('issued_documents').select((eb) => eb.fn.max('sequence').as('n'))
      .where('document_type', '=', type).where('document_id', '=', id).executeTakeFirst();
    const sequence = Number(last?.n ?? 0) + 1;
    const key = `tenants/${tenantId}/documents/${type}/${id}/${sequence}-${sha256.slice(0, 16)}.pdf`;
    await this.storage.put(key, r.pdf, 'application/pdf');
    const row = await tx.insertInto('issued_documents').values({
      tenant_id: tenantId, document_type: type, document_id: id, document_number: r.number, document_revision: r.revision, sequence,
      status_at_issue: r.status, sha256, size_bytes: r.pdf.length, storage_key: key, verification_code: code, issued_by: issuerId,
    }).returning(['id', 'sequence', 'sha256', 'verification_code', 'issued_at']).executeTakeFirstOrThrow();
    await audit(tx, tenantId, { actorUserId: issuerId, action: 'document.issue', entityType: type, entityId: id, data: { documentId: row.id, sequence, sha256 } });
    return row;
  }
}
