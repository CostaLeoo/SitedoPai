// Tipos das tabelas para o Kysely. Mantenha em sincronia com migrations/*.sql.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type TenantStatus = 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY' | 'CLOSED';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export const ROLES = ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'EXECUTOR', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];
export type ScopeType = 'TENANT' | 'UNIT';

export interface TenantsTable {
  id: Generated<string>;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  status: Generated<TenantStatus>;
  created_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  oidc_subject: string | null;
  email: string;
  display_name: string;
  created_at: Timestamp;
}

export interface PlatformAdminsTable {
  user_id: string;
  created_at: Timestamp;
}

export interface UnitsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  code: string;
  city: string | null;
  state: string | null;
  active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SectorsTable {
  id: Generated<string>;
  tenant_id: string;
  unit_id: string;
  name: string;
  active: Generated<boolean>;
  created_at: Timestamp;
}

export interface ContractorsTable {
  id: Generated<string>;
  tenant_id: string;
  legal_name: string;
  cnpj: string;
  active: Generated<boolean>;
  created_at: Timestamp;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  contractor_id: string | null;
  status: Generated<MembershipStatus>;
  created_at: Timestamp;
}

export interface RoleAssignmentsTable {
  id: Generated<string>;
  tenant_id: string;
  membership_id: string;
  role: Role;
  scope_type: ScopeType;
  unit_id: string | null;
  created_at: Timestamp;
}

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Preenchido pelo gatilho; o valor enviado é ignorado. */
  seq: ColumnType<string, number | undefined, never>;
  occurred_at: Timestamp;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  data: ColumnType<unknown, string | undefined, never>;
  prev_hash: ColumnType<string, string | undefined, never>;
  hash: ColumnType<string, string | undefined, never>;
}

export type PublishStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'RETIRED';
export const ANSWERS = ['YES', 'NO', 'NA'] as const;
export type AnswerValue = (typeof ANSWERS)[number];
export const CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const MISMATCH_EFFECTS = ['ALERT', 'PENDING', 'BLOCK'] as const;
export type MismatchEffect = (typeof MISMATCH_EFFECTS)[number];
export type AprStatus = 'DRAFT' | 'IN_REVIEW' | 'RETURNED' | 'APPROVED' | 'CANCELLED';
export const CONTROL_TYPES = ['ELIMINATION', 'SUBSTITUTION', 'ENGINEERING', 'ADMINISTRATIVE', 'PPE'] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];
export type ScanStatus = 'PENDING' | 'CLEAN' | 'REJECTED';

type Json<T> = ColumnType<T, string, string>;

export interface Level { value: number; label: string }
export interface RiskClass { min: number; max: number; label: string; acceptable: boolean }

export interface RiskMatricesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  version: Generated<number>;
  status: Generated<PublishStatus>;
  probability_levels: Json<Level[]>;
  severity_levels: Json<Level[]>;
  classes: Json<RiskClass[]>;
  created_by: string;
  published_by: string | null;
  published_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AprTemplatesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  service_type: string;
  created_by: string;
  created_at: Timestamp;
}

export interface ProfessionalValidation { name: string; registry: string; date: string }

export interface AprTemplateVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  template_id: string;
  version: number;
  status: Generated<PublishStatus>;
  author_id: string;
  submitted_at: NullableTimestamp;
  reviewed_by: string | null;
  reviewed_at: NullableTimestamp;
  review_note: string | null;
  professional_validation: Json<ProfessionalValidation> | null;
  published_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AprTemplateQuestionsTable {
  id: Generated<string>;
  tenant_id: string;
  template_version_id: string;
  position: number;
  text: string;
  help_text: string | null;
  expected_answer: AnswerValue;
  criticality: Generated<Criticality>;
  required: Generated<boolean>;
  allow_na: Generated<boolean>;
  justification_on: ColumnType<string[], string[] | undefined, string[]>;
  photos_required: Generated<number>;
  photos_max: Generated<number>;
  mismatch_effect: Generated<MismatchEffect>;
  normative_ref: string | null;
}

export interface HazardLibraryTable {
  id: Generated<string>;
  tenant_id: string;
  hazard: string;
  consequence: string;
  suggested_controls: Json<{ description: string; type: ControlType }[]>;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  active: Generated<boolean>;
  created_at: Timestamp;
}

export interface TeamMember { name: string; role?: string; membershipId?: string; contractorId?: string }

export interface AprsTable {
  id: Generated<string>;
  tenant_id: string;
  number: string;
  revision: Generated<number>;
  previous_revision_id: string | null;
  template_version_id: string;
  risk_matrix_id: string;
  unit_id: string;
  sector_id: string | null;
  location: Generated<string>;
  activity_date: ColumnType<Date, string, string>;
  service_description: Generated<string>;
  responsible_name: Generated<string>;
  team: Json<TeamMember[]>;
  equipment: Json<string[]>;
  contractor_ids: ColumnType<string[], string[] | undefined, string[]>;
  status: Generated<AprStatus>;
  row_version: Generated<number>;
  analysis_version: Generated<number>;
  created_by: string;
  submitted_by: string | null;
  submitted_at: NullableTimestamp;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decision_note: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AprAnswersTable {
  id: Generated<string>;
  tenant_id: string;
  apr_id: string;
  question_id: string;
  answer: AnswerValue;
  justification: string | null;
  corrective_action: string | null;
  answered_by: string;
  answered_at: Timestamp;
  reassessed_answer: AnswerValue | null;
  reassessed_by: string | null;
  reassessed_at: NullableTimestamp;
  version: Generated<number>;
}

export interface AprStepsTable {
  id: Generated<string>;
  tenant_id: string;
  apr_id: string;
  position: number;
  description: string;
}

export interface AprHazardsTable {
  id: Generated<string>;
  tenant_id: string;
  step_id: string;
  position: number;
  hazard: string;
  consequence: string;
  probability: number | null;
  severity: number | null;
  residual_probability: number | null;
  residual_severity: number | null;
  library_id: string | null;
}

export interface AprControlsTable {
  id: Generated<string>;
  tenant_id: string;
  hazard_id: string;
  position: number;
  description: string;
  control_type: ControlType;
  responsible_name: Generated<string>;
  verified: Generated<boolean>;
}

export interface AprPhotosTable {
  id: Generated<string>;
  tenant_id: string;
  apr_id: string;
  question_id: string;
  apr_revision: number;
  original_key: string;
  display_key: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  scan_status: Generated<ScanStatus>;
  uploaded_by: string;
  received_at: Timestamp;
  removed_at: NullableTimestamp;
  removed_by: string | null;
}

export interface Database {
  risk_matrices: RiskMatricesTable;
  apr_templates: AprTemplatesTable;
  apr_template_versions: AprTemplateVersionsTable;
  apr_template_questions: AprTemplateQuestionsTable;
  hazard_library: HazardLibraryTable;
  aprs: AprsTable;
  apr_answers: AprAnswersTable;
  apr_steps: AprStepsTable;
  apr_hazards: AprHazardsTable;
  apr_controls: AprControlsTable;
  apr_photos: AprPhotosTable;
  tenants: TenantsTable;
  users: UsersTable;
  platform_admins: PlatformAdminsTable;
  units: UnitsTable;
  sectors: SectorsTable;
  contractors: ContractorsTable;
  memberships: MembershipsTable;
  role_assignments: RoleAssignmentsTable;
  audit_events: AuditEventsTable;
}
