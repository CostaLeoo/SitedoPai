import type { AnswerValue, Criticality, Level, MismatchEffect, RiskClass, TeamMember } from '@sitedopai/db';

/**
 * Verificação da APR antes do envio e da aprovação. Função pura: recebe os
 * dados já carregados e devolve pendências. O sistema nunca APROVA sozinho;
 * esta função só pode IMPEDIR o avanço.
 */

export interface QuestionRule {
  id: string;
  position: number;
  text: string;
  expectedAnswer: AnswerValue;
  criticality: Criticality;
  required: boolean;
  allowNa: boolean;
  justificationOn: string[];
  photosRequired: number;
  mismatchEffect: MismatchEffect;
}

export interface AnswerState {
  questionId: string;
  answer: AnswerValue;
  justification: string | null;
  correctiveAction: string | null;
  answeredBy: string;
  reassessedAnswer: AnswerValue | null;
  reassessedBy: string | null;
}

export interface HazardState {
  id: string;
  hazard: string;
  probability: number | null;
  severity: number | null;
  residualProbability: number | null;
  residualSeverity: number | null;
  controls: number;
}

export interface StepState {
  id: string;
  position: number;
  description: string;
  hazards: HazardState[];
}

export interface Matrix {
  probabilityLevels: Level[];
  severityLevels: Level[];
  classes: RiskClass[];
}

export interface AprState {
  location: string;
  serviceDescription: string;
  responsibleName: string;
  team: TeamMember[];
  questions: QuestionRule[];
  answers: AnswerState[];
  /** Fotos ativas e não rejeitadas, por pergunta. */
  photoCounts: Record<string, number>;
  steps: StepState[];
  matrix: Matrix;
}

export interface Issue {
  code: string;
  message: string;
  questionId?: string;
  stepId?: string;
  hazardId?: string;
}

export interface CheckResult {
  ready: boolean;
  blocking: Issue[];
  warnings: Issue[];
  progress: { answered: number; total: number };
}

export function classify(m: Matrix, p: number | null, s: number | null): { score: number; class: RiskClass | null } | null {
  if (p == null || s == null) return null;
  const score = p * s;
  return { score, class: m.classes.find((c) => score >= c.min && score <= c.max) ?? null };
}

/** NA permitido não é divergência; qualquer outra resposta diferente da esperada é. */
export function isMismatch(q: Pick<QuestionRule, 'expectedAnswer' | 'allowNa'>, answer: AnswerValue): boolean {
  if (answer === q.expectedAnswer) return false;
  return !(answer === 'NA' && q.allowNa);
}

export function needsJustification(q: QuestionRule, answer: AnswerValue): boolean {
  return q.justificationOn.includes(answer) || (q.justificationOn.includes('MISMATCH') && isMismatch(q, answer));
}

const blank = (v: string | null | undefined) => !v || !v.trim();

export function checkApr(a: AprState): CheckResult {
  const blocking: Issue[] = [];
  const warnings: Issue[] = [];

  if (blank(a.location)) blocking.push({ code: 'LOCATION_REQUIRED', message: 'Informe o local da atividade.' });
  if (blank(a.serviceDescription)) blocking.push({ code: 'DESCRIPTION_REQUIRED', message: 'Descreva o serviço.' });
  if (blank(a.responsibleName)) blocking.push({ code: 'RESPONSIBLE_REQUIRED', message: 'Informe o responsável.' });
  if (a.team.length === 0) blocking.push({ code: 'TEAM_REQUIRED', message: 'Informe a equipe executante.' });

  const answered = checkAnswers(a.questions, a.answers, a.photoCounts, blocking, warnings);

  if (a.steps.length === 0) blocking.push({ code: 'STEPS_REQUIRED', message: 'Descreva ao menos uma etapa da atividade.' });
  for (const step of a.steps) {
    const sl = `Etapa ${step.position}`;
    if (step.hazards.length === 0) blocking.push({ code: 'HAZARDS_REQUIRED', message: `${sl}: identifique os perigos.`, stepId: step.id });
    for (const h of step.hazards) {
      const hl = `${sl}, perigo "${h.hazard}"`;
      const initial = classify(a.matrix, h.probability, h.severity);
      const residual = classify(a.matrix, h.residualProbability, h.residualSeverity);
      if (!initial) blocking.push({ code: 'RISK_REQUIRED', message: `${hl}: avalie probabilidade e severidade.`, stepId: step.id, hazardId: h.id });
      if (h.controls === 0) blocking.push({ code: 'CONTROLS_REQUIRED', message: `${hl}: inclua ao menos uma medida de controle.`, stepId: step.id, hazardId: h.id });
      if (!residual) {
        blocking.push({ code: 'RESIDUAL_REQUIRED', message: `${hl}: avalie o risco residual.`, stepId: step.id, hazardId: h.id });
        continue;
      }
      if (!residual.class) {
        blocking.push({ code: 'RISK_CLASS_MISSING', message: `${hl}: a matriz não classifica a pontuação ${residual.score}.`, stepId: step.id, hazardId: h.id });
      } else if (!residual.class.acceptable) {
        blocking.push({ code: 'RESIDUAL_UNACCEPTABLE', message: `${hl}: risco residual "${residual.class.label}" não é aceitável. Reforce os controles.`, stepId: step.id, hazardId: h.id });
      }
      if (initial && residual.score > initial.score) {
        warnings.push({ code: 'RESIDUAL_ABOVE_INITIAL', message: `${hl}: o risco residual está maior que o inicial. Confira a avaliação.`, stepId: step.id, hazardId: h.id });
      }
    }
  }

  return { ready: blocking.length === 0, blocking, warnings, progress: { answered, total: a.questions.length } };
}

/** Regras do checklist (Sim/Não/N/A), comuns à APR e à PT. Devolve quantas foram respondidas. */
export function checkAnswers(
  questions: QuestionRule[], answersList: AnswerState[], photoCounts: Record<string, number>,
  blocking: Issue[], warnings: Issue[],
): number {
  const answers = new Map(answersList.map((x) => [x.questionId, x]));
  let answered = 0;
  for (const q of [...questions].sort((x, y) => x.position - y.position)) {
    const ans = answers.get(q.id);
    const label = `Pergunta ${q.position}`;
    if (!ans) {
      if (q.required) blocking.push({ code: 'ANSWER_REQUIRED', message: `${label}: responda Sim, Não ou N/A.`, questionId: q.id });
      continue;
    }
    answered++;
    if (ans.answer === 'NA' && !q.allowNa) {
      blocking.push({ code: 'NA_NOT_ALLOWED', message: `${label}: N/A não é permitido nesta pergunta.`, questionId: q.id });
      continue;
    }
    if (needsJustification(q, ans.answer) && blank(ans.justification)) {
      blocking.push({ code: 'JUSTIFICATION_REQUIRED', message: `${label}: escreva a justificativa.`, questionId: q.id });
    }
    const photos = photoCounts[q.id] ?? 0;
    if (photos < q.photosRequired) {
      blocking.push({ code: 'PHOTOS_REQUIRED', message: `${label}: adicione ${q.photosRequired - photos} foto(s).`, questionId: q.id });
    }
    if (!isMismatch(q, ans.answer)) continue;

    if (q.mismatchEffect === 'ALERT') {
      warnings.push({ code: 'MISMATCH_ALERT', message: `${label}: resposta diferente da esperada. Confira as medidas de controle.`, questionId: q.id });
    } else if (blank(ans.correctiveAction)) {
      blocking.push({ code: 'CORRECTIVE_ACTION_REQUIRED', message: `${label}: registre a ação corretiva.`, questionId: q.id });
    } else if (q.mismatchEffect === 'BLOCK') {
      if (ans.reassessedAnswer == null || ans.reassessedBy == null) {
        blocking.push({ code: 'REASSESSMENT_REQUIRED', message: `${label}: depois da ação corretiva, outra pessoa precisa avaliar de novo.`, questionId: q.id });
      } else if (ans.reassessedBy === ans.answeredBy) {
        blocking.push({ code: 'REASSESSMENT_SAME_PERSON', message: `${label}: a nova avaliação precisa ser feita por outra pessoa.`, questionId: q.id });
      } else if (isMismatch(q, ans.reassessedAnswer)) {
        blocking.push({ code: 'REASSESSMENT_FAILED', message: `${label}: a nova avaliação ainda não confirma a condição segura. A atividade não pode seguir.`, questionId: q.id });
      }
    }
  }

  return answered;
}
