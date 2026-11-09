import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { canOnTenant, canOnUnit, Permission } from '../authz/permissions';
import type { TenantContext } from './request';

export const forbidden = (message = 'Seu perfil não permite esta ação.') => new ForbiddenException({ code: 'FORBIDDEN', message });
export const notFound = (what: string) => new NotFoundException({ code: 'NOT_FOUND', message: `${what} não encontrado(a).` });

export function requireTenantWide(t: TenantContext, p: Permission) {
  if (!canOnTenant(t.assignments, p)) throw forbidden('Esta ação exige um papel válido para a empresa inteira.');
}

export function requireUnit(t: TenantContext, p: Permission, unitId: string) {
  if (!canOnUnit(t.assignments, p, unitId)) throw forbidden('Seu perfil não permite esta ação nesta unidade.');
}
