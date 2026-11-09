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
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, keys, storage), {
    logger: logger ? ['error', 'warn', 'log'] : false,
  });
  app.use(helmet());
  app.useBodyParser('json', { limit: '256kb' });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
