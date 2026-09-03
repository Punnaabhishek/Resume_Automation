/**
 * Client-side filtering. The API re-checks the exclude list and the daily cap at the write,
 * so nothing here is load-bearing for correctness — it exists to avoid opening and
 * abandoning job pages we already know we would not submit, which is both slow and a
 * conspicuous browsing pattern.
 */
import type { JobFilter } from './api.js';

export interface JobCandidate {
  portalJobId: string;
  jobTitle: string;
  company: string;
  location?: string;
  jobUrl?: string;
  /** Optional free text (description/snippet) when the listing exposes one cheaply. */
  snippet?: string;
}

/**
 * Faithful port of normalizeCompany in the API (src/lib/ids.ts). Kept behaviour-compatible
 * on purpose: the worker skips on the same key the server rejects on, so a skip here and a
 * 409 there mean the same thing rather than two subtly different notions of "same company".
 * If that file changes, change this with it.
 */
const LEGAL_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt limited', 'pvt', 'limited', 'ltd', 'llc', 'llp', 'plc',
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'gmbh', 'sa', 'nv', 'bv', 'ag',
];

export function normalizeCompany(name: string): string {
  let out = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (out.endsWith(` ${suffix}`)) {
        out = out.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }

  return out || name.toLowerCase().trim();
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return [value];
    }
  }
  return [];
}

export type SkipReason = 'excluded_company' | 'duplicate' | 'keyword_miss' | 'excluded_keyword' | 'location_miss';

export interface Decision {
  apply: boolean;
  reason?: SkipReason;
}

export function decide(
  job: JobCandidate,
  filter: JobFilter,
  excludedCompanies: Set<string>,
  alreadyApplied: Set<string>,
): Decision {
  if (alreadyApplied.has(job.portalJobId)) return { apply: false, reason: 'duplicate' };
  if (excludedCompanies.has(normalizeCompany(job.company))) return { apply: false, reason: 'excluded_company' };

  const haystack = `${job.jobTitle} ${job.snippet ?? ''}`.toLowerCase();

  const excludedKeywords = asArray(filter.excluded_keywords).map((k) => k.toLowerCase());
  if (excludedKeywords.some((k) => k && haystack.includes(k))) {
    return { apply: false, reason: 'excluded_keyword' };
  }

  // Keywords are an OR: any hit qualifies. A filter is a search, not a specification, and
  // portal search already did most of the narrowing.
  const keywords = asArray(filter.keywords).map((k) => k.toLowerCase()).filter(Boolean);
  if (keywords.length && !keywords.some((k) => haystack.includes(k))) {
    return { apply: false, reason: 'keyword_miss' };
  }

  const locations = asArray(filter.locations).map((l) => l.toLowerCase()).filter(Boolean);
  if (locations.length && job.location) {
    const loc = job.location.toLowerCase();
    const remoteOk = filter.remote_only === 1 && loc.includes('remote');
    if (!remoteOk && !locations.some((l) => loc.includes(l))) {
      return { apply: false, reason: 'location_miss' };
    }
  }

  return { apply: true };
}

/** Portal search URLs want a single query string, not the whole filter object. */
export function searchTerms(filter: JobFilter): string {
  const keywords = asArray(filter.keywords);
  return [filter.designation, ...keywords.slice(0, 2)].filter(Boolean).join(' ').trim();
}

export function primaryLocation(filter: JobFilter): string | undefined {
  const locations = asArray(filter.locations);
  return locations[0];
}
