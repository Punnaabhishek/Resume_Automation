import { createApp } from './app';
import { env } from './config/env';
import { closePool, getPool } from './db/pool';
import { assertVaultReady } from './services/vault';

async function main(): Promise<void> {
  // Both of these fail loudly at boot rather than at the first request that needs them.
  await getPool().query('SELECT 1');
  assertVaultReady();

  const server = createApp().listen(env.port, () => {
    console.log(`API listening on :${env.port} (${env.nodeEnv}), base path ${env.apiBasePath}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Don't let an in-flight request hold the process open indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
