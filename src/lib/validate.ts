import type { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

/**
 * Validate and narrow. Generic over the schema rather than its output type so zod defaults
 * come back non-optional — `.default([])` should not surface as `T[] | undefined`.
 */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
