import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  /** Opcional: por padrão usa o endpoint de chaves do Keycloak. */
  OIDC_JWKS_URL: z.string().url().optional(),
  MFA_AMR_VALUES: z.string().default('otp,mfa,hwk,swk'),
  PORT: z.coerce.number().int().positive().default(3001),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('sa-east-1'),
  S3_ENDPOINT: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof schema> & { mfaAmrValues: string[] };
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Configuração inválida: ${fields}`);
  }
  return {
    ...parsed.data,
    mfaAmrValues: parsed.data.MFA_AMR_VALUES.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
