import { createDevSigner, DevSigner } from './auth/dev-login';
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { JWTVerifyGetKey } from 'jose';
import { AppModule } from './app.module';
import type { AppConfig } from './config';
import type { ObjectStorage } from './storage/storage';

export async function createApp(config: AppConfig, keys?: JWTVerifyGetKey, logger = true, storage?: ObjectStorage): Promise<INestApplication> {
  let dev: DevSigner | undefined;
  if (config.AUTH_MODE === 'dev' && !keys) {
    dev = await createDevSigner(config);
    keys = dev.keys;
    console.warn('ATENÇÃO: login de teste ativo (AUTH_MODE=dev). Não use em produção.');
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, keys, storage, dev), {
    logger: logger ? ['error', 'warn', 'log'] : false,
    // Corpo bruto preservado para conferir a assinatura dos webhooks de pagamento.
    rawBody: true,
  });
  app.use(helmet({ crossOriginResourcePolicy: { policy: config.corsOrigins.length ? 'cross-origin' : 'same-origin' } }));
  if (config.corsOrigins.length) {
    app.enableCors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id'],
      exposedHeaders: ['X-Content-SHA256'],
      maxAge: 600,
    });
  }
  app.useBodyParser('json', { limit: '256kb' });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
