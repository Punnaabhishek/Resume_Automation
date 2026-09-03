import crypto from 'node:crypto';

export const newId = (): string => crypto.randomUUID();

/**
 * Company-name normalization for exclude-list matching and duplicate detection.
 * "Acme Technologies Pvt. Ltd." and "ACME TECHNOLOGIES PRIVATE LIMITED" both land on
 * "acme technologies" so an exclude entry typed one way still blocks the other.
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
