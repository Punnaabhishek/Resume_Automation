import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthorized } from './errors';

export interface OrgMemberClaims {
  sub: string;
  orgId: string;
  role: 'owner' | 'admin' | 'ops' | 'analyst';
  email: string;
}

export function signOrgMemberToken(claims: OrgMemberClaims): string {
  return jwt.sign(claims, env.jwt.secret, { expiresIn: env.jwt.expiresIn } as jwt.SignOptions);
}

export function verifyOrgMemberToken(token: string): OrgMemberClaims {
  try {
    return jwt.verify(token, env.jwt.secret) as OrgMemberClaims;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}
