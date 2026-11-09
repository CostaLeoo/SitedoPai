import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool, PoolConfig } from 'pg';
import type { Database } from './schema';

export * from './schema';
export { migrate } from './migrate';
export { sql };

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, pool?: Partial<PoolConfig>): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 10, ...pool }) }),
  });
}

export interface DbContext {
  /** Empresa ativa. Ausente apenas em rotas sem empresa (sessão, plataforma). */
  tenantId?: string;
  /** Usuário autenticado. Ausente apenas ao resolver o próprio usuário. */
  userId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` numa transação com o contexto de RLS fixado (SET LOCAL).
 * É a ÚNICA forma de a aplicação acessar tabelas de cliente: fora dela,
 * as políticas do banco não retornam linhas.
 */
export async function withContext<T>(db: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (const v of [ctx.tenantId, ctx.userId]) {
    if (v !== undefined && !UUID.test(v)) throw new Error('Contexto de banco inválido');
  }
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true),
                     set_config('app.user_id', ${ctx.userId ?? ''}, true)`.execute(tx);
    return fn(tx);
  });
}

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

/** Grava um evento de auditoria na empresa ativa da transação. */
export async function audit(tx: Tx, tenantId: string, e: AuditInput): Promise<void> {
  await tx
    .insertInto('audit_events')
    .values({
      tenant_id: tenantId,
      actor_user_id: e.actorUserId,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      data: JSON.stringify(e.data ?? {}),
    })
    .execute();
}
