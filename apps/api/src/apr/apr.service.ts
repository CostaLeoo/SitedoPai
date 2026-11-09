import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Level, RiskClass, TeamMember, Tx } from '@sitedopai/db';
import { notFound } from '../common/guards';
import { AprState, checkApr, CheckResult, classify, Matrix } from './rules';

/** Carregamento da APR completa e verificação; usado pelos controladores. */
@Injectable()
export class AprService {
  async loadHeader(tx: Tx, id: string) {
    const apr = await tx.selectFrom('aprs').selectAll().where('id', '=', id).executeTakeFirst();
    if (!apr) throw notFound('APR');
    return apr;
  }

  async loadMatrix(tx: Tx, id: string): Promise<Matrix & { id: string; name: string; version: number }> {
    const m = await tx.selectFrom('risk_matrices').select(['id', 'name', 'version', 'probability_levels', 'severity_levels', 'classes'])
      .where('id', '=', id).executeTakeFirstOrThrow();
    return {
      id: m.id, name: m.name, version: m.version,
      probabilityLevels: m.probability_levels as unknown as Level[],
      severityLevels: m.severity_levels as unknown as Level[],
      classes: m.classes as unknown as RiskClass[],
    };
  }

  async loadFull(tx: Tx, id: string) {
    const apr = await this.loadHeader(tx, id);
    const [questions, answers, steps, hazards, controls, photos, matrix, template] = await Promise.all([
      tx.selectFrom('apr_template_questions').selectAll().where('template_version_id', '=', apr.template_version_id).orderBy('position').execute(),
      tx.selectFrom('apr_answers').selectAll().where('apr_id', '=', id).execute(),
      tx.selectFrom('apr_steps').selectAll().where('apr_id', '=', id).orderBy('position').execute(),
      tx.selectFrom('apr_hazards').innerJoin('apr_steps', 'apr_steps.id', 'apr_hazards.step_id')
        .selectAll('apr_hazards').where('apr_steps.apr_id', '=', id).orderBy('apr_hazards.position').execute(),
      tx.selectFrom('apr_controls').innerJoin('apr_hazards', 'apr_hazards.id', 'apr_controls.hazard_id')
        .innerJoin('apr_steps', 'apr_steps.id', 'apr_hazards.step_id')
        .selectAll('apr_controls').where('apr_steps.apr_id', '=', id).orderBy('apr_controls.position').execute(),
      tx.selectFrom('apr_photos').select(['id', 'question_id', 'mime_type', 'size_bytes', 'sha256', 'width', 'height', 'scan_status', 'received_at', 'uploaded_by'])
        .where('apr_id', '=', id).where('removed_at', 'is', null).orderBy('received_at').execute(),
      this.loadMatrix(tx, apr.risk_matrix_id),
      tx.selectFrom('apr_template_versions').innerJoin('apr_templates', 'apr_templates.id', 'apr_template_versions.template_id')
        .select(['apr_templates.name', 'apr_template_versions.version', 'apr_template_versions.professional_validation'])
        .where('apr_template_versions.id', '=', apr.template_version_id).executeTakeFirstOrThrow(),
    ]);
    return { apr, questions, answers, steps, hazards, controls, photos, matrix, template };
  }

  toState(f: Awaited<ReturnType<AprService['loadFull']>>): AprState {
    const photoCounts: Record<string, number> = {};
    for (const p of f.photos) if (p.scan_status !== 'REJECTED') photoCounts[p.question_id] = (photoCounts[p.question_id] ?? 0) + 1;
    return {
      location: f.apr.location,
      serviceDescription: f.apr.service_description,
      responsibleName: f.apr.responsible_name,
      team: f.apr.team as unknown as TeamMember[],
      questions: f.questions.map((q) => ({
        id: q.id, position: q.position, text: q.text, expectedAnswer: q.expected_answer, criticality: q.criticality,
        required: q.required, allowNa: q.allow_na, justificationOn: q.justification_on, photosRequired: q.photos_required,
        mismatchEffect: q.mismatch_effect,
      })),
      answers: f.answers.map((a) => ({
        questionId: a.question_id, answer: a.answer, justification: a.justification, correctiveAction: a.corrective_action,
        answeredBy: a.answered_by, reassessedAnswer: a.reassessed_answer, reassessedBy: a.reassessed_by,
      })),
      photoCounts,
      steps: f.steps.map((s) => ({
        id: s.id, position: s.position, description: s.description,
        hazards: f.hazards.filter((h) => h.step_id === s.id).map((h) => ({
          id: h.id, hazard: h.hazard, probability: h.probability, severity: h.severity,
          residualProbability: h.residual_probability, residualSeverity: h.residual_severity,
          controls: f.controls.filter((c) => c.hazard_id === h.id).length,
        })),
      })),
      matrix: f.matrix,
    };
  }

  async check(tx: Tx, id: string): Promise<CheckResult> {
    return checkApr(this.toState(await this.loadFull(tx, id)));
  }

  /** Lança 422 com as pendências quando a APR não pode avançar. */
  async assertReady(tx: Tx, id: string): Promise<void> {
    const r = await this.check(tx, id);
    if (!r.ready) {
      throw new UnprocessableEntityException({ code: 'APR_NOT_READY', message: 'A APR tem pendências que impedem o avanço.', blocking: r.blocking, warnings: r.warnings });
    }
  }

  /** Visão para o cliente: sem chaves de armazenamento, com classificação de risco calculada. */
  present(f: Awaited<ReturnType<AprService['loadFull']>>) {
    const { apr } = f;
    return {
      id: apr.id, number: apr.number, revision: apr.revision, previousRevisionId: apr.previous_revision_id, status: apr.status,
      rowVersion: apr.row_version, analysisVersion: apr.analysis_version,
      unitId: apr.unit_id, sectorId: apr.sector_id, location: apr.location, activityDate: apr.activity_date,
      serviceDescription: apr.service_description, responsibleName: apr.responsible_name, team: apr.team,
      equipment: apr.equipment, contractorIds: apr.contractor_ids,
      createdBy: apr.created_by, submittedBy: apr.submitted_by, submittedAt: apr.submitted_at,
      decidedBy: apr.decided_by, decidedAt: apr.decided_at, decisionNote: apr.decision_note,
      template: { id: apr.template_version_id, name: f.template.name, version: f.template.version, professionalValidation: f.template.professional_validation },
      matrix: f.matrix,
      questions: f.questions.map((q) => ({
        id: q.id, position: q.position, text: q.text, helpText: q.help_text, expectedAnswer: q.expected_answer,
        criticality: q.criticality, required: q.required, allowNa: q.allow_na, justificationOn: q.justification_on,
        photosRequired: q.photos_required, photosMax: q.photos_max, mismatchEffect: q.mismatch_effect, normativeRef: q.normative_ref,
      })),
      answers: f.answers.map((a) => ({
        questionId: a.question_id, answer: a.answer, justification: a.justification, correctiveAction: a.corrective_action,
        answeredBy: a.answered_by, answeredAt: a.answered_at, reassessedAnswer: a.reassessed_answer,
        reassessedBy: a.reassessed_by, reassessedAt: a.reassessed_at, version: a.version,
      })),
      steps: f.steps.map((s) => ({
        id: s.id, description: s.description,
        hazards: f.hazards.filter((h) => h.step_id === s.id).map((h) => ({
          id: h.id, hazard: h.hazard, consequence: h.consequence, libraryId: h.library_id,
          probability: h.probability, severity: h.severity, initial: riskView(f.matrix, h.probability, h.severity),
          residualProbability: h.residual_probability, residualSeverity: h.residual_severity,
          residual: riskView(f.matrix, h.residual_probability, h.residual_severity),
          controls: f.controls.filter((c) => c.hazard_id === h.id).map((c) => ({
            id: c.id, description: c.description, type: c.control_type, responsibleName: c.responsible_name, verified: c.verified,
          })),
        })),
      })),
      photos: f.photos.map((p) => ({
        id: p.id, questionId: p.question_id, mimeType: p.mime_type, sizeBytes: p.size_bytes, sha256: p.sha256,
        width: p.width, height: p.height, scanStatus: p.scan_status, receivedAt: p.received_at, uploadedBy: p.uploaded_by,
      })),
    };
  }
}

function riskView(m: Matrix, p: number | null, s: number | null) {
  const c = classify(m, p, s);
  return c ? { score: c.score, label: c.class?.label ?? null, acceptable: c.class?.acceptable ?? null } : null;
}

export function staleVersion(what: string) {
  return new ConflictException({ code: 'STALE_VERSION', message: `${what} foi alterado(a) por outra pessoa. Recarregue para ver a versão atual.` });
}
