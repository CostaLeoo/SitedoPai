import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Aplica migrations/*.sql em ordem, cada uma numa transação, registrando
 * versão e checksum. Recusa rodar se uma migração já aplicada foi alterada.
 * Deve rodar com o papel dono do schema (sitedopai_owner).
 */
export async function migrate(connectionString: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const prev = done.get(version);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migração ${version} foi alterada depois de aplicada`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(body);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${version}: ${(err as Error).message}`);
      }
      applied.push(version);
      log(`aplicada ${version}`);
    }
  } finally {
    await client.end();
  }
  return applied;
}
