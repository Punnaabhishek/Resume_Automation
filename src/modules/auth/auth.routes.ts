import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { queryOne, execute, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { unauthorized } from '../../lib/errors';
import { signOrgMemberToken } from '../../lib/jwt';
import { verifyPassword } from '../../lib/password';
import { parse } from '../../lib/validate';
import { requireMember } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import * as audit from '../audit/audit.service';

interface MemberRow extends RowDataPacket {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: 'owner' | 'admin' | 'ops' | 'analyst';
  status: 'active' | 'disabled';
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many login attempts, try again later' } },
});

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);

    const member = await queryOne<MemberRow>('SELECT * FROM org_members WHERE email = ?', [email.toLowerCase()]);

    // Same response for unknown email, wrong password, and disabled account, so the
    // endpoint cannot be used to enumerate who works here.
    const ok = member ? await verifyPassword(password, member.password_hash) : false;
    if (!member || !ok || member.status !== 'active') {
      throw unauthorized('Invalid credentials');
    }

    await execute('UPDATE org_members SET last_login_at = NOW(3) WHERE id = ?', [member.id]);
    await audit.record({
      orgId: member.org_id,
      actorType: 'org_member',
      actorId: member.id,
      action: 'auth.login',
      ip: clientIp(req),
      userAgent: req.header('user-agent'),
    });

    res.json({
      token: signOrgMemberToken({
        sub: member.id,
        orgId: member.org_id,
        role: member.role,
        email: member.email,
      }),
      member: {
        id: member.id,
        email: member.email,
        fullName: member.full_name,
        role: member.role,
        orgId: member.org_id,
      },
    });
  }),
);

authRouter.get(
  '/me',
  requireMember,
  asyncHandler(async (req, res) => {
    const member = await queryOne<MemberRow>(
      'SELECT id, org_id, email, full_name, role, status FROM org_members WHERE id = ?',
      [req.member!.sub],
    );
    if (!member) throw unauthorized();
    res.json({
      id: member.id,
      email: member.email,
      fullName: member.full_name,
      role: member.role,
      orgId: member.org_id,
    });
  }),
);
