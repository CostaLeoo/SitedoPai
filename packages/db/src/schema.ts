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

export type QualificationKind = 'TRAINING' | 'DESIGNATION' | 'FITNESS' | 'OTHER';
export const TEAM_FUNCTIONS = ['RESPONSIBLE', 'EXECUTOR', 'ENTRY_SUPERVISOR', 'ATTENDANT', 'RESCUE'] as const;
export type TeamFunction = (typeof TEAM_FUNCTIONS)[number];
export type PtStatus = 'DRAFT' | 'IN_ANALYSIS' | 'AWAITING_CORRECTION' | 'AWAITING_APPROVAL' | 'RELEASED' | 'IN_EXECUTION'
  | 'SUSPENDED' | 'CLOSED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
export interface GasParameter { key: string; label: string; unit: string; min?: number; max?: number }

export interface WorkersTable {
  id: Generated<string>; tenant_id: string; full_name: string; registration: string | null;
  contractor_id: string | null; user_id: string | null; active: Generated<boolean>; created_at: Timestamp;
}
export interface QualificationTypesTable {
  id: Generated<string>; tenant_id: string; name: string; kind: QualificationKind; normative_ref: string | null;
  active: Generated<boolean>; created_at: Timestamp;
}
export interface WorkerQualificationsTable {
  id: Generated<string>; tenant_id: string; worker_id: string; type_id: string;
  valid_from: ColumnType<Date, string, string>; valid_until: ColumnType<Date | null, string | null | undefined, string | null>;
  evidence: string | null; recorded_by: string; recorded_at: Timestamp;
  revoked_at: NullableTimestamp; revoked_by: string | null; revoke_reason: string | null;
}
export interface PtTypesTable {
  id: Generated<string>; tenant_id: string; name: string; version: Generated<number>; description: string | null;
  status: Generated<PublishStatus>; checklist_template_version_id: string; max_validity_minutes: number;
  requires_gas_monitoring: Generated<boolean>; gas_parameters: Json<GasParameter[]>; gas_max_age_minutes: number | null;
  requires_entry_log: Generated<boolean>; releaser_qualification_type_id: string | null;
  segregate_creator_releaser: Generated<boolean>; author_id: string; reviewed_by: string | null;
  professional_validation: Json<ProfessionalValidation> | null; published_at: NullableTimestamp; created_at: Timestamp;
}
export interface PtTypeRequirementsTable {
  id: Generated<string>; tenant_id: string; pt_type_id: string; function: TeamFunction; min_count: number;
  qualification_type_ids: ColumnType<string[], string[] | undefined, string[]>;
}
export interface WorkPermitsTable {
  id: Generated<string>; tenant_id: string; number: string; pt_type_id: string; apr_id: string; unit_id: string;
  sector_id: string | null; location: string; description: string; starts_at: ColumnType<Date, Date | string, Date | string>;
  ends_at: ColumnType<Date, Date | string, Date | string>; status: Generated<PtStatus>; row_version: Generated<number>;
  created_by: string; submitted_at: NullableTimestamp; reviewed_by: string | null; reviewed_at: NullableTimestamp;
  released_by: string | null; released_at: NullableTimestamp; suspended_at: NullableTimestamp; status_reason: string | null;
  closed_by: string | null; closed_at: NullableTimestamp; closing_notes: string | null; created_at: Timestamp; updated_at: Timestamp;
}
export interface PtTeamTable {
  id: Generated<string>; tenant_id: string; pt_id: string; worker_id: string; function: TeamFunction;
  acknowledged_signature_id: string | null;
}
export interface PtAnswersTable {
  id: Generated<string>; tenant_id: string; pt_id: string; question_id: string; answer: AnswerValue;
  justification: string | null; corrective_action: string | null; answered_by: string; answered_at: Timestamp;
  reassessed_answer: AnswerValue | null; reassessed_by: string | null; reassessed_at: NullableTimestamp; version: Generated<number>;
}
export interface PtMeasurementsTable {
  id: Generated<string>; tenant_id: string; pt_id: string; parameter_key: string;
  value: ColumnType<string, number, never>; unit: string; within_limits: boolean; instrument: string;
  measured_by: string; received_at: Timestamp;
}
export interface PtEntriesTable {
  id: Generated<string>; tenant_id: string; pt_id: string; worker_id: string; entered_at: Timestamp; entered_by: string;
  exited_at: NullableTimestamp; exited_by: string | null;
}
export interface DocumentSnapshotsTable {
  id: Generated<string>; tenant_id: string; document_type: string; document_id: string; content: string; hash: string; created_at: Timestamp;
}
export interface SignaturesTable {
  id: Generated<string>; tenant_id: string; document_type: string; document_id: string; snapshot_id: string;
  document_hash: string; meaning: string; signer_user_id: string; signer_name: string;
  signer_context: Json<Record<string, unknown>>; evidence: Json<Record<string, unknown>>; signed_at: Timestamp;
}

export type RetentionSource = 'LEGAL' | 'CONTRACT' | 'INTERNAL';
export type DocType = 'apr' | 'work_permit';
export interface IssuedDocumentsTable {
  id: Generated<string>; tenant_id: string; document_type: DocType; document_id: string; document_number: string;
  document_revision: Generated<number>; sequence: number; status_at_issue: string; sha256: string; size_bytes: number;
  storage_key: string; verification_code: string; issued_by: string; issued_at: Timestamp;
}
export interface RetentionRulesTable {
  id: Generated<string>; tenant_id: string; document_type: DocType; pt_type_name: string | null; min_years: number;
  source: RetentionSource; basis: string; active: Generated<boolean>; created_by: string; created_at: Timestamp;
  deactivated_by: string | null; deactivated_at: NullableTimestamp;
}
export interface LegalHoldsTable {
  id: Generated<string>; tenant_id: string; document_type: DocType; document_id: string; reason: string; created_by: string;
  created_at: Timestamp; released_by: string | null; released_at: NullableTimestamp; release_reason: string | null;
}


// ---------------------------------------------------------------------------
// Fase 5: cobrança
// ---------------------------------------------------------------------------
export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
export type InvoiceStatus = 'OPEN' | 'PAID' | 'FAILED' | 'VOID';

export interface PlansTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: Generated<string>;
  billing_interval: Generated<string>;
  max_users: number | null;
  max_units: number | null;
  active: Generated<boolean>;
  created_by: string;
  created_at: Timestamp;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  tenant_id: string;
  plan_id: string;
  plan_name: string;
  price_cents: number;
  max_users: number | null;
  max_units: number | null;
  status: Generated<SubscriptionStatus>;
  grace_days: number;
  provider: string;
  provider_customer_ref: string | null;
  provider_subscription_ref: string | null;
  current_period_end: ColumnType<Date | null, string | null | undefined, string | null>;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface InvoicesTable {
  id: Generated<string>;
  tenant_id: string;
  subscription_id: string;
  amount_cents: number;
  due_date: ColumnType<Date, string, string>;
  status: Generated<InvoiceStatus>;
  provider_charge_ref: string;
  provider: string;
  paid_at: NullableTimestamp;
  failure_reason: string | null;
  receipt_url: string | null;
  created_at: Timestamp;
}

export interface BillingEventsTable {
  id: Generated<string>;
  tenant_id: string;
  provider: string;
  event_id: string;
  type: string;
  data: Json<Record<string, unknown>>;
  body_sha256: string;
  received_at: Timestamp;
}

export interface Database {
  plans: PlansTable;
  subscriptions: SubscriptionsTable;
  invoices: InvoicesTable;
  billing_events: BillingEventsTable;
  issued_documents: IssuedDocumentsTable;
  retention_rules: RetentionRulesTable;
  legal_holds: LegalHoldsTable;
  workers: WorkersTable;
  qualification_types: QualificationTypesTable;
  worker_qualifications: WorkerQualificationsTable;
  pt_types: PtTypesTable;
  pt_type_requirements: PtTypeRequirementsTable;
  work_permits: WorkPermitsTable;
  pt_team: PtTeamTable;
  pt_answers: PtAnswersTable;
  pt_measurements: PtMeasurementsTable;
  pt_entries: PtEntriesTable;
  document_snapshots: DocumentSnapshotsTable;
  signatures: SignaturesTable;
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
