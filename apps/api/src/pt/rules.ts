import type { GasParameter, TeamFunction } from '@sitedopai/db';
import { AnswerState, checkAnswers, Issue, QuestionRule } from '../apr/rules';

/**
 * Verificação da PT. Função pura: só pode IMPEDIR o avanço. A liberação é
 * sempre um ato assinado por uma pessoa; nada aqui libera sozinho.
 * Todos os valores (validade, limites, funções, qualificações) vêm do tipo de PT
 * configurado pelo SST da empresa.
 */

export const FUNCTION_LABEL: Record<TeamFunction, string> = {
  RESPONSIBLE: 'Responsável pela execução',
  EXECUTOR: 'Executante',
  ENTRY_SUPERVISOR: 'Supervisor de entrada',
  ATTENDANT: 'Vigia',
  RESCUE: 'Equipe de resgate',
};

export interface QualificationRecord { typeId: string; validFrom: string; validUntil: string | null; revoked: boolean }
export interface TeamMemberState {
  workerId: string; name: string; function: TeamFunction; active: boolean; hasAccount: boolean;
  qualifications: QualificationRecord[];
}
export interface Requirement { function: TeamFunction; minCount: number; qualificationTypeIds: string[] }
export interface MeasurementState { key: string; withinLimits: boolean; receivedAt: Date }

export interface PtState {
  startsAt: Date;
  endsAt: Date;
  maxValidityMinutes: number;
  apr: { status: string; sameUnit: boolean; superseded: boolean };
  requirements: Requirement[];
  qualificationNames: Record<string, string>;
  team: TeamMemberState[];
  questions: QuestionRule[];
  answers: AnswerState[];
  gas: { required: boolean; parameters: GasParameter[]; maxAgeMinutes: number | null };
  measurements: MeasurementState[];
  suspendedAt: Date | null;
}

export type Stage = 'submit' | 'release' | 'resume';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A qualificação vale durante todo o período da PT e não foi revogada? */
export function coversPeriod(q: QualificationRecord, start: Date, end: Date): boolean {
  return !q.revoked && q.validFrom <= day(start) && (q.validUntil === null || q.validUntil >= day(end));
}

export function withinLimits(p: GasParameter, value: number): boolean {
  return (p.min === undefined || value >= p.min) && (p.max === undefined || value <= p.max);
}

export function checkPt(s: PtState, stage: Stage, now: Date): { ready: boolean; blocking: Issue[]; warnings: Issue[]; progress: { answered: number; total: number } } {
  const blocking: Issue[] = [];
  const warnings: Issue[] = [];

  if (s.apr.status !== 'APPROVED') blocking.push({ code: 'APR_NOT_APPROVED', message: 'A APR vinculada precisa estar aprovada.' });
  if (s.apr.superseded) blocking.push({ code: 'APR_SUPERSEDED', message: 'A APR vinculada foi substituída por uma revisão aprovada. Vincule a revisão atual.' });
  if (!s.apr.sameUnit) blocking.push({ code: 'APR_OTHER_UNIT', message: 'A APR vinculada é de outra unidade.' });

  const minutes = (s.endsAt.getTime() - s.startsAt.getTime()) / 60000;
  if (minutes > s.maxValidityMinutes) {
    blocking.push({ code: 'VALIDITY_TOO_LONG', message: `O período passa da validade máxima deste tipo de PT (${s.maxValidityMinutes} min).` });
  }
  if (stage !== 'submit' && now >= s.endsAt) blocking.push({ code: 'PERIOD_ENDED', message: 'O período da PT já terminou.' });

  for (const r of s.requirements) {
    const members = s.team.filter((m) => m.function === r.function);
    if (members.length < r.minCount) {
      blocking.push({ code: 'TEAM_FUNCTION_MISSING', message: `Inclua ${r.minCount - members.length} pessoa(s) na função "${FUNCTION_LABEL[r.function]}".` });
    }
    for (const m of members) {
      for (const typeId of r.qualificationTypeIds) {
        const ok = m.qualifications.some((q) => q.typeId === typeId && coversPeriod(q, s.startsAt, s.endsAt));
        if (!ok) {
          blocking.push({ code: 'QUALIFICATION_MISSING', message: `${m.name}: sem "${s.qualificationNames[typeId] ?? 'qualificação exigida'}" válida durante todo o período da PT.` });
        }
      }
    }
  }
  if (!s.team.some((m) => m.function === 'EXECUTOR')) blocking.push({ code: 'NO_EXECUTOR', message: 'Inclua ao menos um executante.' });
  for (const m of s.team) {
    if (!m.active) blocking.push({ code: 'WORKER_INACTIVE', message: `${m.name} está inativo(a) no cadastro.` });
    if (!m.hasAccount) blocking.push({ code: 'WORKER_WITHOUT_ACCOUNT', message: `${m.name} não tem acesso ao sistema e não poderá registrar ciência dos riscos.` });
  }

  const answered = checkAnswers(s.questions, s.answers, {}, blocking, warnings);

  if (stage !== 'submit' && s.gas.required) {
    for (const p of s.gas.parameters) {
      const latest = s.measurements.filter((m) => m.key === p.key).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];
      if (!latest) {
        blocking.push({ code: 'GAS_MISSING', message: `Registre a medição de ${p.label}.` });
      } else if (stage === 'resume' && s.suspendedAt && latest.receivedAt <= s.suspendedAt) {
        blocking.push({ code: 'GAS_BEFORE_SUSPENSION', message: `Meça ${p.label} de novo: a última medição é anterior à suspensão.` });
      } else if (now.getTime() - latest.receivedAt.getTime() > (s.gas.maxAgeMinutes ?? 0) * 60000) {
        blocking.push({ code: 'GAS_STALE', message: `A medição de ${p.label} passou de ${s.gas.maxAgeMinutes} min. Meça de novo.` });
      } else if (!latest.withinLimits) {
        blocking.push({ code: 'GAS_OUT_OF_LIMITS', message: `${p.label} fora dos limites definidos. A atividade não pode ser liberada.` });
      }
    }
  }

  return { ready: blocking.length === 0, blocking, warnings, progress: { answered, total: s.questions.length } };
}
