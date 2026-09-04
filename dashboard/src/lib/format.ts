/** Display helpers. Nothing here invents precision the data does not have. */

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const scale: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
  ];

  let n = abs;
  let unit = 'second';
  for (const [step, name] of scale) {
    if (n < step) break;
    n = n / step;
    unit = name === 'second' ? 'minute' : name === 'minute' ? 'hour' : name === 'hour' ? 'day' : name === 'day' ? 'week' : name === 'week' ? 'month' : 'year';
  }

  const rounded = Math.round(n);
  const plural = rounded === 1 ? '' : 's';
  if (abs < 45) return future ? 'in a moment' : 'just now';
  return future ? `in ${rounded} ${unit}${plural}` : `${rounded} ${unit}${plural} ago`;
}

/**
 * Always UTC, always labelled.
 *
 * Not a stylistic choice: the daily application cap resets on `UTC_DATE()` in the API, so an
 * operator reading local time would see "how many are left today" disagree with what the
 * server actually enforces. Every timestamp in this console is therefore UTC and says so.
 */
export function absoluteTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} UTC`;
}

/** Date only, UTC. For chart axes and anywhere a time of day would be noise. */
export function utcDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

export function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Turns snake_case enum values into something readable without losing the original. */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

export function countdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
