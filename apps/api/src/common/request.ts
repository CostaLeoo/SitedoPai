import type { Request } from 'express';
import type { Role, ScopeType } from '@sitedopai/db';

export interface AuthContext {
  userId: string;
  subject: string;
  /** Verdadeiro se o provedor informou um segundo fator no claim "amr". */
  mfa: boolean;
}

export interface Assignment {
  role: Role;
  scopeType: ScopeType;
  unitId: string | null;
}

export interface TenantContext {
  tenantId: string;
  membershipId: string;
  tenantStatus: string;
  assignments: Assignment[];
}

export interface AppRequest extends Request {
  auth?: AuthContext;
  tenant?: TenantContext;
}
