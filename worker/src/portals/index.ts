import type { Portal } from '../api.js';
import { diceAdapter } from './dice.js';
import { indeedAdapter } from './indeed.js';
import { linkedinAdapter } from './linkedin.js';
import { mockAdapter } from './mock.js';
import type { PortalAdapter } from './types.js';

const ADAPTERS: Record<Portal, PortalAdapter> = {
  linkedin: linkedinAdapter,
  indeed: indeedAdapter,
  dice: diceAdapter,
  mock: mockAdapter,
};

export function adapterFor(portal: Portal): PortalAdapter {
  const adapter = ADAPTERS[portal];
  if (!adapter) throw new Error(`No adapter for portal "${portal}"`);
  return adapter;
}

export type { PortalAdapter } from './types.js';
