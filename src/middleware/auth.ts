import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyOrgMemberToken, type OrgMemberClaims } from '../lib/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      member?: OrgMemberClaims;
      workerId?: string;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/** Ops dashboard auth. The only human-facing auth in the system — job seekers never log in. */
export const requireMember: RequestHandler = (req, _res, next) => {
  const token = bearer(req);
  if (!token) throw unauthorized();
  req.member = verifyOrgMemberToken(token);
  next();
};

export function requireRole(...roles: OrgMemberClaims['role'][]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.member) throw unauthorized();
    if (!roles.includes(req.member.role)) {
      throw forbidden(`Requires one of: ${roles.join(', ')}`);
    }
    next();
  };
}

/**
 * Auth for the Playwright automation service. A shared bearer token, compared in constant
 * time, plus a worker id header so runs and credential access can be attributed to a
 * specific worker process.
 */
export const requireWorker: RequestHandler = (req, _res, next) => {
  const token = bearer(req);
  if (!token) throw unauthorized();

  const expected = Buffer.from(env.workerApiToken);
  const provided = Buffer.from(token);
  const ok = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  if (!ok) throw unauthorized('Invalid worker token');

  const workerId = req.header('x-worker-id');
  if (!workerId) throw unauthorized('Missing X-Worker-Id header');
  req.workerId = workerId.slice(0, 80);

  next();
};
