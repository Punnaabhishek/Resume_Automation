/**
 * Timing. The API enforces the daily cap and will reject an over-cap write, but it does not
 * enforce the gap between applications — that lives here, because it is about how the
 * traffic looks rather than how much of it there is.
 *
 * Every wait is jittered. A worker that applied exactly every 240s would be a clearer
 * signal than one that applied at all.
 */
import { log } from './log.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform jitter of +/- `spread` (0-1) around `ms`. */
export function jitter(ms: number, spread = 0.25): number {
  const delta = ms * spread;
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2));
}

export async function pauseBetweenApplications(minMinutes: number): Promise<void> {
  const ms = jitter(minMinutes * 60_000, 0.35);
  log.info('pacing: waiting before next application', { seconds: Math.round(ms / 1000) });
  await sleep(ms);
}

/** Short pause standing in for a human reading the page before acting on it. */
export async function think(minMs = 700, maxMs = 2400): Promise<void> {
  await sleep(Math.round(minMs + Math.random() * (maxMs - minMs)));
}

/** Tracks the hard ceiling on a single run so one wedged portal cannot hold a slot forever. */
export class RunClock {
  private readonly deadline: number;

  constructor(maxMinutes: number) {
    this.deadline = Date.now() + maxMinutes * 60_000;
  }

  get expired(): boolean {
    return Date.now() >= this.deadline;
  }

  get remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }
}
