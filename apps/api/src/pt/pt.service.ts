import { Injectable } from '@nestjs/common';
import { audit, GasParameter, sql, TeamMember, Tx } from '@sitedopai/db';
import { notFound } from '../common/guards';
import { checkPt, PtState, Stage } from './rules';

/** Carrega a PT, aplica a expiração e monta o estado para verificação e assinatura. */
@Injectable()
export class PtService {
  /** Marca como expiradas as PTs vencidas da empresa e registra na auditoria. */
  async syncExpiry(tx: Tx, tenantId: string) {
    const r = await sql<{ expire_work_permits: string }>`SELECT expire_work_permits()`.execute(tx);
    for (const row of r.rows) {
      await audit(tx, tenantId, { actorUserId: null, action: 'pt.expire', entityType: 'work_permit', entityId: row.expire_work_permits });
    }
  }

  async load(tx: Tx, id: string, lock = false) {
    let q = tx.selectFrom('work_permits').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const pt = await q.executeTakeFirst();
    if (!pt) throw notFound('PT');
    return pt;
  }

  async loadFull(tx: Tx, id: string) {
    const pt = await this.load(tx, id);
    const type = await tx.selectFrom('pt_types').selectAll().where('id', '=', pt.pt_type_id).executeTakeFirstOrThrow();
    const [requirements, team, questions, answers, measurements, entries, apr, newerApr, signatures] = await Promise.all([
      tx.selectFrom('pt_type_requirements').selectAll().where('pt_type_id', '=', type.id).execute(),
      tx.selectFrom('pt_team').innerJoin('workers', 'workers.id', 'pt_team.worker_id')
        .select(['pt_team.id', 'pt_team.worker_id', 'pt_team.function', 'pt_team.acknowledged_signature_id',
          'workers.full_name', 'workers.registration', 'workers.user_id', 'workers.active', 'workers.contractor_id'])
        .where('pt_team.pt_id', '=', id).orderBy('workers.full_name').execute(),
      tx.selectFrom('apr_template_questions').selectAll().where('template_version_id', '=', type.checklist_template_version_id).orderBy('position').execute(),
      tx.selectFrom('pt_answers').selectAll().where('pt_id', '=', id).execute(),
      tx.selectFrom('pt_measurements').selectAll().where('pt_id', '=', id).orderBy('received_at').execute(),
      tx.selectFrom('pt_entries').innerJoin('workers', 'workers.id', 'pt_entries.worker_id')
        .select(['pt_entries.id', 'pt_entries.worker_id', 'workers.full_name', 'pt_entries.entered_at', 'pt_entries.exited_at'])
        .where('pt_entries.pt_id', '=', id).orderBy('pt_entries.entered_at').execute(),
      tx.selectFrom('aprs').select(['id', 'number', 'revision', 'status', 'unit_id']).where('id', '=', pt.apr_id).executeTakeFirstOrThrow(),
      tx.selectFrom('aprs').select('id').where('previous_revision_id', '=', pt.apr_id).where('status', '=', 'APPROVED').executeTakeFirst(),
      tx.selectFrom('signatures').select(['id', 'meaning', 'signer_user_id', 'signer_name', 'document_hash', 'signed_at', 'snapshot_id'])
        .where('document_type', '=', 'work_permit').where('document_id', '=', id).orderBy('signed_at').execute(),
    ]);
    const workerIds = team.map((m) => m.worker_id);
    const quals = workerIds.length
      ? await tx.selectFrom('worker_qualifications').select(['worker_id', 'type_id', 'valid_from', 'valid_until', 'revoked_at'])
        .where('worker_id', 'in', workerIds).execute()
      : [];
    const typeIds = [...new Set(requirements.flatMap((r) => r.qualification_type_ids))];
    const qualTypes = typeIds.length ? await tx.selectFrom('qualification_types').select(['id', 'name']).where('id', 'in', typeIds).execute() : [];
    return { pt, type, requirements, team, questions, answers, measurements, entries, apr, superseded: !!newerApr, signatures, quals, qualTypes };
  }

  state(f: Awaited<ReturnType<PtService['loadFull']>>): PtState {
    const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);
    return {
      startsAt: f.pt.starts_at, endsAt: f.pt.ends_at, maxValidityMinutes: f.type.max_validity_minutes,
      apr: { status: f.apr.status, sameUnit: f.apr.unit_id === f.pt.unit_id, superseded: f.superseded },
      requirements: f.requirements.map((r) => ({ function: r.function, minCount: r.min_count, qualificationTypeIds: r.qualification_type_ids })),
      qualificationNames: Object.fromEntries(f.qualTypes.map((q) => [q.id, q.name])),
      team: f.team.map((m) => ({
        workerId: m.worker_id, name: m.full_name, function: m.function, active: m.active, hasAccount: !!m.user_id,
        qualifications: f.quals.filter((q) => q.worker_id === m.worker_id).map((q) => ({
          typeId: q.type_id, validFrom: d(q.valid_from)!, validUntil: d(q.valid_until), revoked: q.revoked_at !== null,
        })),
      })),
      questions: f.questions.map((q) => ({
        id: q.id, position: q.position, text: q.text, expectedAnswer: q.expected_answer, criticality: q.criticality,
        required: q.required, allowNa: q.allow_na, justificationOn: q.justification_on, photosRequired: q.photos_required, mismatchEffect: q.mismatch_effect,
      })),
      answers: f.answers.map((a) => ({
        questionId: a.question_id, answer: a.answer, justification: a.justification, correctiveAction: a.corrective_action,
        answeredBy: a.answered_by, reassessedAnswer: a.reassessed_answer, reassessedBy: a.reassessed_by,
      })),
      gas: { required: f.type.requires_gas_monitoring, parameters: f.type.gas_parameters as unknown as GasParameter[], maxAgeMinutes: f.type.gas_max_age_minutes },
      measurements: f.measurements.map((m) => ({ key: m.parameter_key, withinLimits: m.within_limits, receivedAt: m.received_at })),
      suspendedAt: f.pt.suspended_at,
    };
  }

  check(f: Awaited<ReturnType<PtService['loadFull']>>, stage: Stage, now = new Date()) {
    return checkPt(this.state(f), stage, now);
  }

  /**
   * Conteúdo assinado: o que define a autorização (dados, equipe, checklist e a
   * última medição de cada parâmetro até `asOf`). Fica de fora o que muda com o
   * tempo sem alterar a autorização: situação, versão interna, medições futuras.
   */
  snapshot(f: Awaited<ReturnType<PtService['loadFull']>>, asOf: Date = new Date()) {
    const lastByParam = new Map<string, (typeof f.measurements)[number]>();
    for (const m of f.measurements) if (m.received_at <= asOf) lastByParam.set(m.parameter_key, m);
    return {
      documentType: 'work_permit',
      id: f.pt.id, number: f.pt.number,
      ptType: { id: f.type.id, name: f.type.name, version: f.type.version },
      apr: { id: f.apr.id, number: f.apr.number, revision: f.apr.revision },
      unitId: f.pt.unit_id, sectorId: f.pt.sector_id, location: f.pt.location, description: f.pt.description,
      startsAt: f.pt.starts_at, endsAt: f.pt.ends_at,
      team: f.team.map((m) => ({ workerId: m.worker_id, name: m.full_name, function: m.function }))
        .sort((a, b) => (a.workerId + a.function).localeCompare(b.workerId + b.function)),
      answers: f.answers.map((a) => ({
        questionId: a.question_id, answer: a.answer, justification: a.justification, correctiveAction: a.corrective_action,
        reassessedAnswer: a.reassessed_answer,
      })).sort((a, b) => a.questionId.localeCompare(b.questionId)),
      measurements: [...lastByParam.values()].map((m) => ({ id: m.id, key: m.parameter_key, value: m.value, unit: m.unit, withinLimits: m.within_limits, receivedAt: m.received_at }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  /** "Vale como autorização agora?" Nunca confia só na situação gravada: confere o prazo. */
  validity(pt: { status: string; starts_at: Date; ends_at: Date }, now = new Date()) {
    if (pt.status !== 'RELEASED' && pt.status !== 'IN_EXECUTION') {
      return { valid: false, reason: `PT ${STATUS_TEXT[pt.status] ?? pt.status}: não vale como autorização.` };
    }
    if (now >= pt.ends_at) return { valid: false, reason: 'Prazo de validade encerrado.' };
    if (now < pt.starts_at) return { valid: false, reason: 'O período da PT ainda não começou.' };
    return { valid: true, reason: null };
  }
}

export const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'em rascunho', IN_ANALYSIS: 'em análise', AWAITING_CORRECTION: 'aguardando correção', AWAITING_APPROVAL: 'aguardando aprovação',
  RELEASED: 'liberada', IN_EXECUTION: 'em execução', SUSPENDED: 'suspensa', CLOSED: 'encerrada', REJECTED: 'rejeitada',
  CANCELLED: 'cancelada', EXPIRED: 'expirada',
};

export type { TeamMember };
