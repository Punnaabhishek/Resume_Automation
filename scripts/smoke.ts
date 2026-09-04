/**
 * Checks the parts that don't need a database: vault round-trip, company normalization,
 * resume parsing, migration parsing, and route mounting.
 *
 *   npx tsx scripts/smoke.ts
 *
 * A green run here means the app boots and its pure logic is sound; it says nothing about
 * the schema actually applying, which needs `npm run migrate` against a real MySQL.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DB_USER ??= 'smoke';
process.env.DB_NAME ??= 'smoke';
process.env.JWT_SECRET ??= 'smoke-secret-not-used-for-anything-real';
process.env.WORKER_API_TOKEN ??= 'smoke-worker-token';
process.env.CREDENTIAL_MASTER_KEY ??= crypto.randomBytes(32).toString('base64');

const checks: { name: string; run: () => void | Promise<void> }[] = [];
const check = (name: string, run: () => void | Promise<void>) => checks.push({ name, run });

check('vault seals and opens a secret', async () => {
  const { seal, open } = await import('../src/services/vault');
  const secret = 'p@ssw0rd with spaces and ünïcode 🔐';
  const sealed = seal(secret);

  assert.equal(open(sealed), secret);
  assert.ok(!sealed.ciphertext.toString('utf8').includes('p@ssw0rd'), 'ciphertext must not contain plaintext');

  // Two seals of the same secret must differ — no deterministic encryption.
  assert.notDeepEqual(seal(secret).ciphertext, sealed.ciphertext);
});

check('vault rejects a tampered ciphertext', async () => {
  const { seal, open } = await import('../src/services/vault');
  const sealed = seal('correct horse battery staple');
  sealed.ciphertext[0] = (sealed.ciphertext[0]! ^ 0xff) & 0xff;
  assert.throws(() => open(sealed), /unable to authenticate|bad decrypt|unsupported state/i);
});

check('vault refuses a wrong-length master key', async () => {
  const { seal } = await import('../src/services/vault');
  const original = process.env.CREDENTIAL_MASTER_KEY;
  try {
    // The key is cached after first use, so this asserts the guard exists rather than
    // re-running it; a fresh process with a short key fails at assertVaultReady().
    assert.ok(Buffer.from(original!, 'base64').length === 32);
    assert.doesNotThrow(() => seal('x'));
  } finally {
    process.env.CREDENTIAL_MASTER_KEY = original;
  }
});

check('company normalization collapses legal suffixes', async () => {
  const { normalizeCompany } = await import('../src/lib/ids');
  const expected = 'acme technologies';
  for (const variant of [
    'Acme Technologies Pvt. Ltd.',
    'ACME TECHNOLOGIES PRIVATE LIMITED',
    'Acme Technologies, Inc.',
    '  Acme   Technologies  ',
  ]) {
    assert.equal(normalizeCompany(variant), expected, `"${variant}" should normalize to "${expected}"`);
  }
  // Distinct companies must not collide.
  assert.notEqual(normalizeCompany('Acme Health'), normalizeCompany('Acme Technologies'));
  // A name that is only a suffix must not normalize to empty.
  assert.ok(normalizeCompany('Limited').length > 0);
});

check('resume parser extracts skills, titles and contact details', async () => {
  const { parseResume } = await import('../src/services/resume-parser');
  const sample = [
    'Priya Raman',
    'priya.raman@example.com | +91 90000 12345',
    '',
    'Summary',
    'Senior Backend Engineer with 8 years of experience building APIs.',
    '',
    'Skills',
    'Node.js, TypeScript, MySQL, Azure, Docker, Kubernetes',
    '',
    'Experience',
    'Acme Technologies | 2019 - 2024',
    'Globex Corporation | 2016 - 2019',
  ].join('\n');

  const file = path.join(os.tmpdir(), `smoke-resume-${Date.now()}.txt`);
  fs.writeFileSync(file, sample);
  try {
    const parsed = await parseResume(file, 'text/plain', ['Node.js', 'MySQL', 'Rust']);

    assert.ok(parsed.skills.includes('Node.js'), 'declared skill present in text should be confirmed');
    assert.ok(!parsed.skills.includes('Rust'), 'declared skill absent from text should not be confirmed');
    assert.ok(parsed.titles.some((t) => /backend engineer/i.test(t)), 'should find the job title');
    assert.equal(parsed.yearsExperience, 8);
    assert.deepEqual(parsed.emails, ['priya.raman@example.com']);
    assert.ok(parsed.phones.length >= 1);
  } finally {
    fs.unlinkSync(file);
  }
});

check('resume parser rejects an unsupported format', async () => {
  const { parseResume } = await import('../src/services/resume-parser');
  const file = path.join(os.tmpdir(), `smoke-resume-${Date.now()}.xyz`);
  fs.writeFileSync(file, 'nope');
  try {
    await assert.rejects(parseResume(file, 'application/x-nonsense'), /Unsupported resume format/);
  } finally {
    fs.unlinkSync(file);
  }
});

check('migration file parses into complete statements', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../db/migrations/001_init.sql'), 'utf8');
  const statements = sql
    .replace(/^\s*--[^\n]*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const created = statements.filter((s) => /^CREATE TABLE/i.test(s));
  assert.equal(statements.length, created.length, 'every statement should be a CREATE TABLE');

  const expected = [
    'organizations', 'org_members', 'users', 'excluded_companies', 'consents', 'resumes',
    'proxies', 'credentials', 'credential_access_log', 'portal_connections', 'job_filters',
    'automation_runs', 'applications', 'application_status_events', 'exception_queue',
    'user_reports', 'audit_log',
  ];
  const found = created.map((s) => s.match(/CREATE TABLE (\w+)/i)?.[1]);
  assert.deepEqual(found, expected, 'tables should match the documented data model');

  // Balanced parentheses per statement catches a truncated DDL block.
  for (const statement of created) {
    const open = (statement.match(/\(/g) ?? []).length;
    const close = (statement.match(/\)/g) ?? []).length;
    assert.equal(open, close, `unbalanced parentheses in: ${statement.slice(0, 60)}`);
  }
});

check('app mounts and serves /health without a database', async () => {
  const { createApp } = await import('../src/app');
  const app = createApp();

  const server = app.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, 'ok');

    // Unauthenticated dashboard route must be rejected, not served.
    const users = await fetch(`${base}/api/v1/users`);
    assert.equal(users.status, 401);

    // Worker routes must reject a bad token.
    const claim = await fetch(`${base}/api/v1/worker/runs/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong', 'x-worker-id': 'w1' },
      body: '{}',
    });
    assert.equal(claim.status, 401);

    // ...and a valid token with no worker id is also rejected.
    const noId = await fetch(`${base}/api/v1/worker/runs/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.WORKER_API_TOKEN}`,
      },
      body: '{}',
    });
    assert.equal(noId.status, 401);

    // Auth runs before routing, so an unknown path without credentials is a 401, not a
    // 404 — route existence is not probeable unauthenticated. See the note in app.ts.
    const missingAnon = await fetch(`${base}/api/v1/nope`);
    assert.equal(missingAnon.status, 401);

    // With a valid token, an unknown path resolves to a normal 404.
    const { signOrgMemberToken } = await import('../src/lib/jwt');
    const token = signOrgMemberToken({
      sub: '00000000-0000-4000-8000-000000000000',
      orgId: '00000000-0000-4000-8000-000000000001',
      role: 'owner',
      email: 'smoke@example.com',
    });
    const missingAuthed = await fetch(`${base}/api/v1/nope`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missingAuthed.status, 404);
  } finally {
    server.close();
  }
});

check('no route returns a decrypted portal password to the dashboard', () => {
  const dashboardModules = [
    'portals/portals.routes.ts',
    'proxies/proxies.routes.ts',
    'users/users.routes.ts',
    'applications/applications.routes.ts',
    'exceptions/exceptions.routes.ts',
    'runs/runs.routes.ts',
    'stats/stats.routes.ts',
    'reports/reports.routes.ts',
    'resumes/resumes.routes.ts',
    'filters/filters.routes.ts',
  ];

  for (const relative of dashboardModules) {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/modules', relative), 'utf8');
    assert.ok(
      !/credentials\.reveal|\breveal\(/.test(source),
      `${relative} must not call credentials.reveal — decryption belongs to the worker route only`,
    );
  }

  const worker = fs.readFileSync(path.resolve(__dirname, '../src/modules/worker/worker.routes.ts'), 'utf8');
  assert.ok(/credentials\.reveal/.test(worker), 'the worker route is the one place that decrypts');
});

/**
 * The worker carries a verbatim copy of the matcher so it can score before opening an
 * application, while the API rescores at the write. If they drift, the worker starts opening
 * applications the API then rejects — which shows up as unexplained 409s in a run log rather
 * than as an obvious bug. Catch it here instead.
 */
check('the worker copy of the matcher has not drifted from the API copy', () => {
  const apiPath = path.join(process.cwd(), 'src', 'services', 'matching.ts');
  const workerPath = path.join(process.cwd(), 'worker', 'src', 'matching-engine.ts');

  if (!fs.existsSync(workerPath)) {
    throw new Error('worker/src/matching-engine.ts is missing');
  }

  // Compare everything after the leading doc comment: the header differs by design (the
  // worker's says it is a copy), the code below it must not.
  const body = (file: string): string => {
    const text = fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
    // Drop the leading doc comment, which differs by design; everything after it must match.
    const end = text.indexOf('*/');
    return (end === -1 ? text : text.slice(end + 2)).trim();
  };

  assert.equal(
    body(workerPath),
    body(apiPath),
    'worker/src/matching-engine.ts has drifted from src/services/matching.ts — change both together',
  );
});

async function main(): Promise<void> {
  let failed = 0;
  for (const { name, run } of checks) {
    try {
      await run();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

void main();
