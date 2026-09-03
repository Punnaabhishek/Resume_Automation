/**
 * The worker process. Claims one run at a time and works it to completion.
 *
 * Single-run concurrency is deliberate. Each run drives a real browser and a real person's
 * account, and the pacing between applications is measured in minutes — so the bottleneck is
 * wall-clock politeness, not CPU. Scale by running more of these processes with distinct
 * WORKER_IDs (optionally sharded by WORKER_PORTALS) rather than by making one process
 * juggle browsers; the queue hands each claim out with SELECT … FOR UPDATE SKIP LOCKED, so
 * they will not collide.
 */
import { api, pingApi } from './api.js';
import { config } from './config.js';
import { log } from './log.js';
import { sleep } from './pacing.js';
import { executeRun } from './run.js';

let stopping = false;
/** Set while a run is in flight so shutdown waits for it rather than abandoning it mid-apply. */
let inFlight: Promise<void> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`received ${signal}; finishing current run before exit`);
  if (inFlight) await inFlight.catch(() => {});
  log.info('worker stopped');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  const once = process.argv.includes('--once');

  log.info('worker starting', {
    workerId: config.workerId,
    api: config.apiBaseUrl,
    portals: config.portals.length ? config.portals.join(',') : 'any',
    headless: config.headless,
    mode: once ? 'once' : 'loop',
  });

  if (!(await pingApi())) {
    log.error('API is not reachable or not ready; refusing to start');
    process.exit(1);
  }

  while (!stopping) {
    let runId: string | null = null;
    try {
      runId = await api.claimRun(config.portals);
    } catch (err) {
      log.error('could not claim a run', { error: (err as Error).message });
      if (once) process.exit(1);
      await sleep(config.idlePollSeconds * 1000);
      continue;
    }

    if (!runId) {
      if (once) {
        log.info('queue is empty; nothing to do');
        return;
      }
      await sleep(config.idlePollSeconds * 1000);
      continue;
    }

    log.info('claimed run', { runId });
    // executeRun contains its own try/finally and always reports a terminal status, so a
    // throw escaping it means something is wrong with the worker rather than the run.
    inFlight = executeRun(runId);
    try {
      await inFlight;
    } catch (err) {
      log.error('unhandled error while working a run', { runId, error: (err as Error).message });
    } finally {
      inFlight = null;
    }

    if (once) return;
  }
}

main().catch((err) => {
  log.error('worker crashed', { error: (err as Error).message });
  process.exit(1);
});
