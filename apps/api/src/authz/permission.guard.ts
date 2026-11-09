import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION } from '../common/decorators';
import type { AppRequest } from '../common/request';
import { hasAny, Permission } from './permissions';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const p = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, [ctx.getHandler(), ctx.getClass()]);
    if (!p) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.tenant || !hasAny(req.tenant.assignments, p)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Seu perfil não permite esta ação.' });
    }
    return true;
  }
}
