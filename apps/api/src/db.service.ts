import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createDb, Db, DbContext, Tx, withContext } from '@sitedopai/db';
import { APP_CONFIG, AppConfig } from './config';

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly db: Db;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.db = createDb(config.DATABASE_URL);
  }

  /** Toda leitura e escrita de dados de cliente passa por aqui. */
  run<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.db, ctx, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
