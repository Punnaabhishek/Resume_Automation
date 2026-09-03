/**
 * Onboard one real job seeker, end to end.
 *
 * This is the intake path. Everything a person needs before automation can run for them —
 * profile, consents, portal credentials, resume, search filters — goes in through here,
 * because it all goes in through the API and there is deliberately no screen that accepts a
 * portal password.
 *
 *   npx tsx scripts/intake.ts intake/someone.json
 *   npx tsx scripts/intake.ts intake/someone.json --dry-run
 *
 * Copy intake/example.json, fill it in, run it, then shred the file — it contains a real
 * person's portal passwords in plaintext until you do. The intake/ directory is gitignored
 * apart from the example.
 *
 * Idempotent where it can be: re-running against an existing email updates the profile and
 * rotates credentials rather than erroring, so a half-finished intake can be resumed.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const API = (process.env.INTAKE_API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}/api/v1`).replace(/\/$/, '');
const OPS_EMAIL = process.env.INTAKE_OPS_EMAIL;
const OPS_PASSWORD = process.env.INTAKE_OPS_PASSWORD;

const DRY_RUN = process.argv.includes('--dry-run');
const filePath = process.argv.find((a) => a.endsWith('.json'));

interface PortalEntry {
  portal: 'linkedin' | 'indeed' | 'dice';
  username: string;
  /** Omit to be prompted on stdin instead of keeping it in the file. */
  password?: string;
}

interface FilterEntry {
  name: string;
  designation: string;
  keywords: string[];
  excludedKeywords?: string[];
  locations?: string[];
  remoteOnly?: boolean;
  seniority?: string;
  employmentTypes?: string[];
  minSalary?: number;
  salaryCurrency?: string;
  portals: ('linkedin' | 'indeed' | 'dice')[];
  postedWithinDays?: number;
  priority?: number;
}

interface IntakeFile {
  fullName: string;
  email: string;
  phone?: string;
  country: string;
  state?: string;
  city?: string;
  timezone?: string;
  targetDesignations: string[];
  keySkills?: string[];
  servicePlan?: string;
  intakeChannel?: 'form' | 'whatsapp' | 'phone' | 'email' | 'other';
  dailyApplicationCap?: number;
  minMinutesBetweenApplications?: number;
  excludedCompanies?: { companyName: string; reason?: string }[];
  notes?: string;
  /** Evidence that the person authorized this. Recorded against all three consents. */
  consent: { version: string; capturedVia: string; evidenceRef: string };
  resumePath: string;
  portals: PortalEntry[];
  filters: FilterEntry[];
  /** Queue a run per connected portal as soon as intake completes. */
  queueRunsNow?: boolean;
}

let token = '';

async function call<T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';

  const res = await fetch(`${API}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function fail(message: string, detail?: unknown): never {
  console.error(`\n  ✗ ${message}`);
  if (detail !== undefined) console.error(`    ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.exit(1);
}

function describe(body: any): string {
  const err = body?.error;
  if (!err) return JSON.stringify(body);
  const details = Array.isArray(err.details)
    ? err.details.map((d: any) => (typeof d === 'string' ? d : `${d.path}: ${d.message}`)).join('; ')
    : '';
  return details ? `${err.message} — ${details}` : err.message;
}

const step = (label: string) => process.stdout.write(`  ${label.padEnd(52, '.')} `);
const ok = (note = 'ok') => console.log(note);

async function main(): Promise<void> {
  if (!filePath) fail('Usage: npx tsx scripts/intake.ts <intake-file.json> [--dry-run]');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) fail(`No such file: ${resolved}`);

  const data = JSON.parse(fs.readFileSync(resolved, 'utf8')) as IntakeFile;

  for (const required of ['fullName', 'email', 'country', 'targetDesignations', 'consent', 'resumePath', 'portals', 'filters'] as const) {
    if (data[required] === undefined) fail(`Intake file is missing "${required}"`);
  }

  const resumeAbs = path.resolve(path.dirname(resolved), data.resumePath);
  if (!fs.existsSync(resumeAbs)) fail(`Resume not found: ${resumeAbs}`);

  console.log(`\nIntake: ${data.fullName} <${data.email}>`);
  console.log(`API:    ${API}`);
  console.log(`Resume: ${resumeAbs}`);
  console.log(`Portals: ${data.portals.map((p) => p.portal).join(', ')}`);
  console.log(`Filters: ${data.filters.length}`);

  if (DRY_RUN) {
    console.log('\n  --dry-run: the file parses and the resume exists. Nothing was sent.\n');
    return;
  }

  // Prompt for any password left out of the file, so a real password need never be written
  // to disk at all.
  const missing = data.portals.filter((p) => !p.password);
  if (missing.length) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    for (const entry of missing) {
      entry.password = await rl.question(`  ${entry.portal} password for ${entry.username}: `);
      if (!entry.password) fail(`No password given for ${entry.portal}`);
    }
    rl.close();
  }

  console.log('');

  // --- sign in -------------------------------------------------------------
  step('signing in as an operator');
  if (!OPS_EMAIL || !OPS_PASSWORD) {
    fail('Set INTAKE_OPS_EMAIL and INTAKE_OPS_PASSWORD', 'These are your org_members login, not a job seeker.');
  }
  const login = await call('POST', '/auth/login', { email: OPS_EMAIL, password: OPS_PASSWORD });
  if (login.status !== 200) fail('Operator sign-in failed', describe(login.body));
  token = login.body.token;
  ok(`as ${login.body.member.email} (${login.body.member.role})`);

  // --- profile -------------------------------------------------------------
  step('creating the job seeker');
  const profile = {
    fullName: data.fullName,
    email: data.email,
    phone: data.phone,
    country: data.country,
    state: data.state,
    city: data.city,
    timezone: data.timezone ?? 'UTC',
    targetDesignations: data.targetDesignations,
    keySkills: data.keySkills ?? [],
    servicePlan: data.servicePlan,
    intakeChannel: data.intakeChannel,
    dailyApplicationCap: data.dailyApplicationCap,
    minMinutesBetweenApplications: data.minMinutesBetweenApplications,
    excludedCompanies: data.excludedCompanies ?? [],
    notes: data.notes,
  };

  let userId = '';
  const created = await call('POST', '/users', profile);
  if (created.status === 201) {
    userId = created.body.id;
    ok(`created ${userId}`);
  } else if (created.status === 409) {
    // Resume a half-finished intake rather than making the operator clean up by hand.
    const found = await call('GET', `/users?search=${encodeURIComponent(data.email)}`);
    const existing = (found.body?.data ?? []).find(
      (u: any) => u.email?.toLowerCase() === data.email.toLowerCase(),
    );
    if (!existing) fail('Email is taken but the user could not be found', describe(created.body));
    userId = existing.id;
    const patched = await call('PATCH', `/users/${userId}`, profile);
    if (patched.status !== 200) fail('Could not update the existing record', describe(patched.body));
    ok(`already existed, updated ${userId}`);
  } else {
    fail('Could not create the job seeker', describe(created.body));
  }

  // --- consents ------------------------------------------------------------
  // credential_storage gates credential provisioning and automated_apply gates the queue,
  // both server-side. Recording them is not paperwork; without them nothing else works.
  for (const consentType of ['credential_storage', 'automated_apply', 'data_processing'] as const) {
    step(`recording consent: ${consentType}`);
    const res = await call('POST', `/users/${userId}/consents`, {
      consentType,
      version: data.consent.version,
      capturedVia: data.consent.capturedVia,
      evidenceRef: data.consent.evidenceRef,
    });
    if (res.status !== 201) fail(`Could not record ${consentType} consent`, describe(res.body));
    ok();
  }

  // --- resume --------------------------------------------------------------
  step('uploading the resume');
  const form = new FormData();
  const bytes = fs.readFileSync(resumeAbs);
  const ext = path.extname(resumeAbs).toLowerCase();
  const mime =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/plain';
  form.append('resume', new Blob([bytes], { type: mime }), path.basename(resumeAbs));
  form.append('isPrimary', 'true');

  const resume = await call('POST', `/users/${userId}/resumes`, form);
  if (resume.status !== 201) fail('Resume upload failed', describe(resume.body));
  const parseNote =
    resume.body.parseStatus === 'parsed'
      ? `parsed${resume.body.parsed?.yearsExperience ? `, ${resume.body.parsed.yearsExperience}y experience` : ''}`
      : `stored but ${resume.body.parseStatus}${resume.body.parseError ? `: ${resume.body.parseError}` : ''}`;
  ok(parseNote);

  // --- portal credentials --------------------------------------------------
  for (const entry of data.portals) {
    step(`storing ${entry.portal} credentials`);
    const res = await call('POST', `/users/${userId}/connections`, {
      portal: entry.portal,
      username: entry.username,
      password: entry.password,
    });
    if (res.status !== 201) fail(`Could not store ${entry.portal} credentials`, describe(res.body));

    // The response must never echo the secret back. Check rather than assume.
    if (entry.password && JSON.stringify(res.body).includes(entry.password)) {
      fail('The API echoed the password back — stop and investigate before continuing');
    }
    ok(res.body.proxyId ? 'encrypted, proxy assigned' : 'encrypted, NO PROXY AVAILABLE');
  }

  // --- filters -------------------------------------------------------------
  for (const filter of data.filters) {
    step(`creating filter: ${filter.name}`);
    const res = await call('POST', `/users/${userId}/filters`, filter);
    if (res.status !== 201) fail(`Could not create filter "${filter.name}"`, describe(res.body));
    ok(`${filter.portals.join(', ')}`);
  }

  // --- activate ------------------------------------------------------------
  step('activating');
  const activate = await call('PATCH', `/users/${userId}`, { status: 'active' });
  if (activate.status !== 200) fail('Could not activate', describe(activate.body));
  ok();

  // --- eligibility ---------------------------------------------------------
  console.log('');
  const eligible: string[] = [];
  for (const entry of data.portals) {
    step(`eligibility: ${entry.portal}`);
    const res = await call('GET', `/runs/eligibility?userId=${userId}&portal=${entry.portal}`);
    if (res.status !== 200) {
      ok(`could not check — ${describe(res.body)}`);
      continue;
    }
    if (res.body.eligible) {
      eligible.push(entry.portal);
      ok(`ready, ${res.body.remainingToday} applications left today`);
    } else {
      ok(`NOT eligible — ${res.body.reasons.join('; ')}`);
    }
  }

  // --- optionally queue ----------------------------------------------------
  if (data.queueRunsNow) {
    console.log('');
    for (const portal of eligible) {
      step(`queueing a run: ${portal}`);
      const res = await call('POST', '/runs', { userId, portal });
      if (res.status !== 201) ok(`refused — ${describe(res.body)}`);
      else ok(`run ${res.body.runId}`);
    }
  }

  console.log(`\n  Done. ${data.fullName} is ${eligible.length ? 'ready to automate' : 'set up but not yet eligible'}.`);
  console.log(`  Job seeker id: ${userId}`);
  console.log(`  Dashboard:     http://localhost:3000/users/${userId}\n`);

  if (data.portals.some((p) => p.password) ) {
    console.log('  This intake file still holds real portal passwords in plaintext.');
    console.log(`  Shred it now:  rm ${resolved}`);
    console.log('  Next time, leave "password" out of the file and let this script prompt.\n');
  }

  if (!data.queueRunsNow && eligible.length) {
    console.log('  To start applying, queue a run per portal:');
    for (const portal of eligible) {
      console.log(`    curl -X POST ${API}/runs -H "authorization: Bearer <token>" \\`);
      console.log(`      -H 'content-type: application/json' -d '{"userId":"${userId}","portal":"${portal}"}'`);
    }
    console.log('  Or click "Queue <portal>" on the dashboard page above.\n');
  }

}

main().catch((err) => fail('Intake failed', (err as Error).message));
