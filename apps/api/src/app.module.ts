import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { JWTVerifyGetKey } from 'jose';
import { AuthGuard } from './auth/auth.guard';
import { remoteKeys, TOKEN_KEYS, TokenVerifier } from './auth/token-verifier';
import { PermissionGuard } from './authz/permission.guard';
import { ErrorsFilter } from './common/errors.filter';
import { APP_CONFIG, AppConfig } from './config';
import { DbService } from './db.service';
import { AuditController } from './modules/audit.controller';
import { MembershipsController } from './modules/memberships.controller';
import { PlatformController } from './modules/platform.controller';
import { SessionController } from './modules/session.controller';
import { UnitsController } from './modules/units.controller';
import { TenantGuard } from './tenancy/tenant.guard';

@Module({})
export class AppModule {
  /** `keys` permite aos testes usar chaves locais no lugar do Keycloak. */
  static forRoot(config: AppConfig, keys?: JWTVerifyGetKey): DynamicModule {
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }])],
      controllers: [SessionController, UnitsController, MembershipsController, AuditController, PlatformController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: TOKEN_KEYS, useValue: keys ?? remoteKeys(config) },
        DbService,
        TokenVerifier,
        // Ordem importa: limite de taxa → autenticação → empresa → permissão.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_FILTER, useClass: ErrorsFilter },
      ],
    };
  }
}
