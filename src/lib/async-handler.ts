import type { NextFunction, Request, Response, RequestHandler } from 'express';

/** Express 4 does not forward rejected promises to the error middleware; this does. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
