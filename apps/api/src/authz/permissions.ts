import type { Role } from '@sitedopai/db';
import type { Assignment } from '../common/request';

/**
 * Permissões da Fase 1. Cada permissão lista os papéis que a concedem.
 * Qualificações e segregação de funções entram na Fase 3 (liberação de PT).
 */
export const PERMISSIONS = {
  'unit.read': ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'EXECUTOR', 'AUDITOR'],
  'unit.write': ['COMPANY_ADMIN'],
  'sector.write': ['COMPANY_ADMIN', 'SST'],
  'membership.read': ['COMPANY_ADMIN', 'AUDITOR'],
  'membership.write': ['COMPANY_ADMIN'],
  'audit.read': ['COMPANY_ADMIN', 'AUDITOR'],
  'config.read': ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'EXECUTOR', 'AUDITOR'],
  'risk_matrix.write': ['SST'],
  'template.write': ['SST'],
  'template.review': ['SST'],
  'hazard_library.write': ['SST'],
  'apr.read': ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'EXECUTOR', 'AUDITOR'],
  'apr.write': ['SST', 'SUPERVISOR', 'EXECUTOR'],
  'apr.approve': ['SST', 'SUPERVISOR'],
  'people.read': ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'AUDITOR'],
  'people.write': ['COMPANY_ADMIN', 'SST'],
  'pt_type.write': ['SST'],
  'pt_type.review': ['SST'],
  'pt.read': ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'EXECUTOR', 'AUDITOR'],
  'pt.write': ['SST', 'SUPERVISOR', 'EXECUTOR'],
  'pt.review': ['SST'],
  'pt.release': ['SST', 'SUPERVISOR'],
  'pt.field': ['SST', 'SUPERVISOR', 'EXECUTOR'],
  'apr.photo_original': ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'AUDITOR'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Papéis que exigem MFA em toda requisição. */
export const PRIVILEGED_ROLES: readonly Role[] = ['COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'AUDITOR'];

function grants(a: Assignment, p: Permission): boolean {
  return (PERMISSIONS[p] as readonly Role[]).includes(a.role);
}

/** Tem a permissão em algum escopo? */
export function hasAny(assignments: Assignment[], p: Permission): boolean {
  return assignments.some((a) => grants(a, p));
}

/** Tem a permissão para a unidade indicada (escopo da empresa inteira ou da unidade)? */
export function canOnUnit(assignments: Assignment[], p: Permission, unitId: string): boolean {
  return assignments.some((a) => grants(a, p) && (a.scopeType === 'TENANT' || a.unitId === unitId));
}

/** Tem a permissão na empresa inteira? */
export function canOnTenant(assignments: Assignment[], p: Permission): boolean {
  return assignments.some((a) => grants(a, p) && a.scopeType === 'TENANT');
}

/** Unidades em que a permissão vale; `all` quando vale para a empresa inteira. */
export function unitScope(assignments: Assignment[], p: Permission): { all: true } | { all: false; unitIds: string[] } {
  if (canOnTenant(assignments, p)) return { all: true };
  return { all: false, unitIds: assignments.filter((a) => grants(a, p) && a.unitId).map((a) => a.unitId!) };
}
