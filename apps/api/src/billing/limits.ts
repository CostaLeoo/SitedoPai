import { HttpException, HttpStatus } from '@nestjs/common';
import { sql, Tx } from '@sitedopai/db';

/**
 * Limites contratados (usuários e unidades). Sem assinatura ou sem limite no
 * plano, não há bloqueio. Nunca é usado em ações de segurança das PTs.
 */
export async function enforcePlanLimit(tx: Tx, tenantId: string, kind: 'users' | 'units', adding = 1) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`limit:${kind}:${tenantId}`}))`.execute(tx);
  const sub = await tx.selectFrom('subscriptions').select(['max_users', 'max_units']).where('status', '<>', 'CANCELED').executeTakeFirst();
  const max = kind === 'users' ? sub?.max_users : sub?.max_units;
  if (!max) return;
  const used = kind === 'users'
    ? Number((await tx.selectFrom('memberships').select((eb) => eb.fn.countAll().as('n')).where('status', '<>', 'SUSPENDED').executeTakeFirstOrThrow()).n)
    : Number((await tx.selectFrom('units').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  if (used + adding > max) {
    throw new HttpException({
      code: 'PLAN_LIMIT',
      message: kind === 'users'
        ? `O plano contratado permite ${max} usuário(s) ativo(s). Suspenda um acesso ou fale com o comercial para ampliar.`
        : `O plano contratado permite ${max} unidade(s). Fale com o comercial para ampliar.`,
    }, HttpStatus.PAYMENT_REQUIRED);
  }
}
