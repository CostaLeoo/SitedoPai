export type Answer = 'YES' | 'NO' | 'NA';
export type AprStatus = 'DRAFT' | 'IN_REVIEW' | 'RETURNED' | 'APPROVED' | 'CANCELLED';
export type ControlType = 'ELIMINATION' | 'SUBSTITUTION' | 'ENGINEERING' | 'ADMINISTRATIVE' | 'PPE';
export interface Level { value: number; label: string }
export interface RiskClass { min: number; max: number; label: string; acceptable: boolean }
export interface RoleRef { role: string; scopeType: 'TENANT' | 'UNIT'; unitId: string | null }
export interface Me {
  user: { id: string; email: string; displayName: string; mfa: boolean };
  tenants: { tenantId: string; name: string; status: string; roles: RoleRef[] }[];
}
export interface Question {
  id: string; position: number; text: string; helpText: string | null; expectedAnswer: Answer;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; required: boolean; allowNa: boolean; justificationOn: string[];
  photosRequired: number; photosMax: number; mismatchEffect: 'ALERT' | 'PENDING' | 'BLOCK'; normativeRef: string | null;
}
export interface AnswerRow {
  questionId: string; answer: Answer; justification: string | null; correctiveAction: string | null; answeredBy: string;
  reassessedAnswer: Answer | null; reassessedBy: string | null; version: number;
}
export interface Control { id?: string; description: string; type: ControlType; responsibleName: string; verified: boolean }
export interface Hazard {
  id?: string; hazard: string; consequence: string; probability: number | null; severity: number | null;
  residualProbability: number | null; residualSeverity: number | null; controls: Control[];
  initial?: RiskView | null; residual?: RiskView | null;
}
export interface RiskView { score: number; label: string | null; acceptable: boolean | null }
export interface Step { id?: string; description: string; hazards: Hazard[] }
export interface Photo { id: string; questionId: string; sha256: string; receivedAt: string }
export interface Apr {
  id: string; number: string; revision: number; status: AprStatus; rowVersion: number; analysisVersion: number;
  unitId: string; location: string; activityDate: string; serviceDescription: string; responsibleName: string;
  team: { name: string; role?: string }[]; equipment: string[]; createdBy: string; decisionNote: string | null;
  template: { name: string; version: number };
  matrix: { probabilityLevels: Level[]; severityLevels: Level[]; classes: RiskClass[] };
  questions: Question[]; answers: AnswerRow[]; steps: Step[]; photos: Photo[];
}
export interface Check {
  ready: boolean; blocking: { code: string; message: string; questionId?: string; stepId?: string; hazardId?: string }[];
  warnings: { code: string; message: string; questionId?: string }[]; progress: { answered: number; total: number };
}
