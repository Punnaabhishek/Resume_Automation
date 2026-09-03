/**
 * Line-per-event logging. Deliberately has no `debug`-level dump of page content: this
 * process handles plaintext portal passwords and OTP codes, and the cheapest way to keep
 * them out of logs is to have no code path that writes arbitrary values.
 */
type Level = 'info' | 'warn' | 'error';

let context: Record<string, string> = {};

export function setContext(next: Record<string, string>): void {
  context = next;
}

export function clearContext(): void {
  context = {};
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5)];
  const merged = { ...context, ...fields };
  const tags = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  parts.push(message);
  if (tags) parts.push(`| ${tags}`);
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};
