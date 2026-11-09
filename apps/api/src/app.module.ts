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
import { AprsController } from './modules/aprs.controller';
import { PhotosController } from './modules/photos.controller';
import { RiskMatricesController } from './modules/risk-matrices.controller';
import { TemplatesController } from './modules/templates.controller';
import { AprService } from './apr/apr.service';
import { SignatureService } from './common/signature';
import { PeopleController } from './modules/people.controller';
import { PtTypesController } from './modules/pt-types.controller';
import { WorkPermitsController } from './modules/work-permits.controller';
import { PtService } from './pt/pt.service';
import { LocalStorage, OBJECT_STORAGE, ObjectStorage, S3Storage } from './storage/storage';
import { DEV_SIGNER, DevLoginController, DevSigner } from './auth/dev-login';
import { DocumentsController, VerifyController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { RetentionController } from './documents/retention.controller';
import { BillingService } from './billing/billing.service';
import { BillingWebhookController, CompanyBillingController, PlatformBillingController } from './billing/billing.controller';
import { ExportController } from './billing/export.controller';
import { PAYMENT_PROVIDER, PaymentProvider, SimulatedProvider } from './billing/provider';
import { DashboardController } from './modules/dashboard.controller';
import { TenantGuard } from './tenancy/tenant.guard';

@Module({})
export class AppModule {
  /** `keys` permite aos testes usar chaves locais no lugar do Keycloak. */
  static forRoot(config: AppConfig, keys?: JWTVerifyGetKey, storage?: ObjectStorage, dev?: DevSigner, payment?: PaymentProvider): DynamicModule {
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }])],
      controllers: [SessionController, UnitsController, MembershipsController, AuditController, PlatformController,
        RiskMatricesController, TemplatesController, AprsController, PhotosController,
        PeopleController, PtTypesController, WorkPermitsController,
        DocumentsController, VerifyController, RetentionController,
        PlatformBillingController, BillingWebhookController, CompanyBillingController, ExportController, DashboardController, ...(dev ? [DevLoginController] : [])],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        ...(dev ? [{ provide: DEV_SIGNER, useValue: dev }] : []),
        { provide: TOKEN_KEYS, useValue: keys ?? remoteKeys(config) },
        { provide: OBJECT_STORAGE, useValue: storage ?? createStorage(config) },
        DbService,
        TokenVerifier,
        AprService,
        PtService,
        DocumentsService,
        BillingService,
        { provide: PAYMENT_PROVIDER, useValue: payment ?? new SimulatedProvider(config.BILLING_WEBHOOK_SECRET) },
        SignatureService,
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

function createStorage(config: AppConfig): ObjectStorage {
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET) throw new Error('Defina S3_BUCKET para STORAGE_DRIVER=s3');
    return new S3Storage(config.S3_BUCKET, { region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: !!config.S3_ENDPOINT });
  }
  return new LocalStorage(config.STORAGE_DIR);
}
