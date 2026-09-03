import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { asyncHandler } from '../../lib/async-handler';
import { param } from '../../lib/params';
import { badRequest, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { requireMember, requireRole } from '../../middleware/auth';
import { clientIp } from '../../middleware/request-context';
import { env } from '../../config/env';
import * as audit from '../audit/audit.service';
import { parseResume } from '../../services/resume-parser';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(env.storage.resumes, param(req, 'userId') ?? 'unassigned');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    // Never reuse the client-supplied name on disk; the original is kept in the DB column.
    filename: (_req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: env.storage.maxResumeBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(badRequest(`Unsupported file type: ${file.mimetype}. Accepts PDF, DOCX, DOC, or TXT.`));
      return;
    }
    cb(null, true);
  },
});

interface ResumeRow extends RowDataPacket {
  id: string;
  user_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  is_primary: number;
  parse_status: string;
  parse_error: string | null;
  parsed: Record<string, unknown> | null;
  parsed_at: Date | null;
  created_at: Date;
}

function present(row: ResumeRow) {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    isPrimary: row.is_primary === 1,
    parseStatus: row.parse_status,
    parseError: row.parse_error,
    parsed: row.parsed,
    parsedAt: row.parsed_at,
    createdAt: row.created_at,
  };
}

async function sha256(filePath: string): Promise<string> {
  const buffer = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export const resumesRouter = Router();
resumesRouter.use(requireMember);

resumesRouter.get(
  '/users/:userId/resumes',
  asyncHandler(async (req, res) => {
    const user = await queryOne<RowDataPacket>('SELECT id FROM users WHERE id = ? AND org_id = ?', [
      param(req, 'userId'),
      req.member!.orgId,
    ]);
    if (!user) throw notFound('User');

    const rows = await query<ResumeRow>(
      'SELECT * FROM resumes WHERE user_id = ? ORDER BY is_primary DESC, created_at DESC',
      [param(req, 'userId')],
    );
    res.json({ data: rows.map(present) });
  }),
);

resumesRouter.post(
  '/users/:userId/resumes',
  requireRole('owner', 'admin', 'ops'),
  upload.single('resume'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('Expected a file in the "resume" field');

    const user = await queryOne<RowDataPacket & { key_skills: string[] }>(
      'SELECT id, key_skills FROM users WHERE id = ? AND org_id = ?',
      [param(req, 'userId'), req.member!.orgId],
    );
    if (!user) {
      await fsp.unlink(file.path).catch(() => {});
      throw notFound('User');
    }

    const id = newId();
    const makePrimary = req.body?.isPrimary === 'true' || req.body?.isPrimary === true;

    await execute(
      `INSERT INTO resumes (id, user_id, file_name, mime_type, size_bytes, storage_path, checksum_sha256, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, user.id, file.originalname, file.mimetype, file.size,
        path.relative(env.storage.root, file.path), await sha256(file.path), makePrimary ? 1 : 0,
      ],
    );

    if (makePrimary) {
      await execute('UPDATE resumes SET is_primary = 0 WHERE user_id = ? AND id <> ?', [user.id, id]);
    } else {
      // First resume for a user becomes primary automatically, so the worker always has one.
      await execute(
        `UPDATE resumes SET is_primary = 1
          WHERE id = ? AND (SELECT c FROM (SELECT COUNT(*) c FROM resumes WHERE user_id = ?) t) = 1`,
        [id, user.id],
      );
    }

    // Parse inline: it takes well under a second for a résumé and failure is non-fatal, so
    // it is not worth a queue hop. A failed parse leaves the row usable for upload/autofill.
    try {
      const parsed = await parseResume(file.path, file.mimetype, user.key_skills ?? []);
      await execute(
        `UPDATE resumes SET parse_status = 'parsed', parsed = ?, parsed_at = NOW(3), parse_error = NULL WHERE id = ?`,
        [JSON.stringify(parsed), id],
      );
    } catch (err) {
      await execute(`UPDATE resumes SET parse_status = 'failed', parse_error = ? WHERE id = ?`, [
        err instanceof Error ? err.message : String(err),
        id,
      ]);
    }

    await audit.record({
      orgId: req.member!.orgId,
      userId: user.id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'resume.upload',
      entityType: 'resume',
      entityId: id,
      metadata: { fileName: file.originalname, sizeBytes: file.size },
      ip: clientIp(req),
    });

    const row = await queryOne<ResumeRow>('SELECT * FROM resumes WHERE id = ?', [id]);
    res.status(201).json(present(row!));
  }),
);

resumesRouter.post(
  '/resumes/:id/primary',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const row = await queryOne<ResumeRow>(
      'SELECT r.* FROM resumes r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND u.org_id = ?',
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Resume');

    await execute('UPDATE resumes SET is_primary = 0 WHERE user_id = ?', [row.user_id]);
    await execute('UPDATE resumes SET is_primary = 1 WHERE id = ?', [row.id]);
    res.json({ id: row.id, isPrimary: true });
  }),
);

/** Re-run parsing, e.g. after the parser improves or the user's declared skills change. */
resumesRouter.post(
  '/resumes/:id/reparse',
  requireRole('owner', 'admin', 'ops'),
  asyncHandler(async (req, res) => {
    const row = await queryOne<ResumeRow & { key_skills: string[] }>(
      `SELECT r.*, u.key_skills FROM resumes r JOIN users u ON u.id = r.user_id
        WHERE r.id = ? AND u.org_id = ?`,
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Resume');

    const absolute = path.join(env.storage.root, row.storage_path);
    try {
      const parsed = await parseResume(absolute, row.mime_type, row.key_skills ?? []);
      await execute(
        `UPDATE resumes SET parse_status = 'parsed', parsed = ?, parsed_at = NOW(3), parse_error = NULL WHERE id = ?`,
        [JSON.stringify(parsed), row.id],
      );
      res.json({ parseStatus: 'parsed', parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await execute(`UPDATE resumes SET parse_status = 'failed', parse_error = ? WHERE id = ?`, [message, row.id]);
      res.status(422).json({ parseStatus: 'failed', parseError: message });
    }
  }),
);

resumesRouter.get(
  '/resumes/:id/download',
  asyncHandler(async (req, res) => {
    const row = await queryOne<ResumeRow>(
      'SELECT r.* FROM resumes r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND u.org_id = ?',
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Resume');

    // storage_path is written by the server, but resolve-and-check anyway so a malformed
    // row can never reach outside the storage root.
    const absolute = path.resolve(env.storage.root, row.storage_path);
    if (!absolute.startsWith(path.resolve(env.storage.resumes))) throw notFound('Resume file');
    if (!fs.existsSync(absolute)) throw notFound('Resume file');

    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'resume.download',
      entityType: 'resume',
      entityId: row.id,
      ip: clientIp(req),
    });

    res.download(absolute, row.file_name);
  }),
);

resumesRouter.delete(
  '/resumes/:id',
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await queryOne<ResumeRow>(
      'SELECT r.* FROM resumes r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND u.org_id = ?',
      [param(req, 'id'), req.member!.orgId],
    );
    if (!row) throw notFound('Resume');

    await execute('DELETE FROM resumes WHERE id = ?', [row.id]);
    await fsp.unlink(path.resolve(env.storage.root, row.storage_path)).catch(() => {});

    await audit.record({
      orgId: req.member!.orgId,
      userId: row.user_id,
      actorType: 'org_member',
      actorId: req.member!.sub,
      action: 'resume.delete',
      entityType: 'resume',
      entityId: row.id,
      ip: clientIp(req),
    });
    res.status(204).end();
  }),
);
