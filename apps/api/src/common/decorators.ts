import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '../authz/permissions';
import type { AppRequest } from './request';

export const PUBLIC = 'route:public';
export const NO_TENANT = 'route:no-tenant';
export const PLATFORM = 'route:platform';
export const PERMISSION = 'route:permission';

/** Rota sem autenticação (ex.: health check). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Rota autenticada que não opera sobre uma empresa (ex.: /me). */
export const NoTenant = () => SetMetadata(NO_TENANT, true);
/** Rota do administrador da plataforma: sem empresa e com MFA obrigatório. */
export const PlatformOnly = () => SetMetadata(PLATFORM, true);
/** Permissão exigida em algum escopo; a checagem por unidade fica no serviço. */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION, p);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return req.auth!;
});

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return req.tenant!;
});
