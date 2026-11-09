// Tipos das tabelas para o Kysely. Mantenha em sincronia com migrations/*.sql.
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

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
  created_at: Generated<Timestamp>;
}

export interface UsersTable {
  id: Generated<string>;
  oidc_subject: string | null;
  email: string;
  display_name: string;
  created_at: Generated<Timestamp>;
}

export interface PlatformAdminsTable {
  user_id: string;
  created_at: Generated<Timestamp>;
}

export interface UnitsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  code: string;
  city: string | null;
  state: string | null;
  active: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SectorsTable {
  id: Generated<string>;
  tenant_id: string;
  unit_id: string;
  name: string;
  active: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface ContractorsTable {
  id: Generated<string>;
  tenant_id: string;
  legal_name: string;
  cnpj: string;
  active: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  contractor_id: string | null;
  status: Generated<MembershipStatus>;
  created_at: Generated<Timestamp>;
}

export interface RoleAssignmentsTable {
  id: Generated<string>;
  tenant_id: string;
  membership_id: string;
  role: Role;
  scope_type: ScopeType;
  unit_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Preenchido pelo gatilho; o valor enviado é ignorado. */
  seq: ColumnType<string, number | undefined, never>;
  occurred_at: Generated<Timestamp>;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  data: ColumnType<unknown, string | undefined, never>;
  prev_hash: ColumnType<string, string | undefined, never>;
  hash: ColumnType<string, string | undefined, never>;
}

export interface Database {
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
