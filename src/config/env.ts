import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? './storage');

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: num('PORT', 4000),
  apiBasePath: process.env.API_BASE_PATH ?? '/api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: num('DB_PORT', 3306),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database: required('DB_NAME'),
    connectionLimit: num('DB_CONNECTION_LIMIT', 10),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },

  workerApiToken: required('WORKER_API_TOKEN'),

  vault: {
    // In production this should be fetched from Azure Key Vault at boot rather than read
    // from a .env file. The rest of the code only cares that it is 32 bytes.
    masterKey: process.env.CREDENTIAL_MASTER_KEY ?? '',
    keyVersion: num('CREDENTIAL_KEY_VERSION', 1),
  },

  storage: {
    root: storageRoot,
    resumes: path.join(storageRoot, 'resumes'),
    sessions: path.join(storageRoot, 'sessions'),
    reports: path.join(storageRoot, 'reports'),
    maxResumeBytes: num('MAX_RESUME_BYTES', 10 * 1024 * 1024),
  },

  pacing: {
    defaultDailyCap: num('DEFAULT_DAILY_APPLICATION_CAP', 25),
    defaultMinMinutesBetween: num('DEFAULT_MIN_MINUTES_BETWEEN_APPLICATIONS', 4),
  },
} as const;

export type Env = typeof env;
