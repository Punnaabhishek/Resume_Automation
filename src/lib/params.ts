import type { Request } from 'express';
import { badRequest } from './errors';

/**
 * Read a route parameter. Express types params as possibly-undefined under
 * `noUncheckedIndexedAccess`; a route that reaches its handler always has its declared
 * params, so this narrows in one place instead of a non-null assertion at every use.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (value === undefined) throw badRequest(`Missing route parameter: ${name}`);
  return value;
}
