/**
 * Development seed: one organization, one owner login, one job seeker with consent on file,
 * a filter, an exclude entry, and a proxy. Enough to exercise the queue end to end.
 *
 * Idempotent — safe to re-run. Refuses to run against NODE_ENV=production.
 */
import { closePool, execute, queryOne, type RowDataPacket } from '../src/db/pool';
import { env } from '../src/config/env';
import { hashPassword } from '../src/lib/password';
import { newId, normalizeCompany } from '../src/lib/ids';

const ORG_SLUG = 'demo-org';
const OWNER_EMAIL = 'ops@example.com';
const OWNER_PASSWORD = 'ChangeMe123!';
const SEEKER_EMAIL = 'jobseeker@example.com';

async function seed(): Promise<void> {
  if (env.isProduction) {
    throw new Error('Refusing to seed a production database.');
  }

  let org = await queryOne<RowDataPacket & { id: string }>('SELECT id FROM organizations WHERE slug = ?', [ORG_SLUG]);
  if (!org) {
    const id = newId();
    await execute('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)', [id, 'Demo Operator', ORG_SLUG]);
    org = { id } as RowDataPacket & { id: string };
    console.log(`organization  ${id}`);
  }

  const existingOwner = await queryOne<RowDataPacket>('SELECT id FROM org_members WHERE email = ?', [OWNER_EMAIL]);
  if (!existingOwner) {
    const id = newId();
    await execute(
      `INSERT INTO org_members (id, org_id, email, password_hash, full_name, role)
       VALUES (?, ?, ?, ?, ?, 'owner')`,
      [id, org.id, OWNER_EMAIL, await hashPassword(OWNER_PASSWORD), 'Demo Owner'],
    );
    console.log(`org_member    ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  }

  let user = await queryOne<RowDataPacket & { id: string }>('SELECT id FROM users WHERE org_id = ? AND email = ?', [
    org.id,
    SEEKER_EMAIL,
  ]);
  if (!user) {
    const id = newId();
    await execute(
      `INSERT INTO users
         (id, org_id, full_name, email, phone, country, state, city, timezone,
          target_designations, key_skills, status, service_plan, intake_channel,
          intake_completed_at, daily_application_cap, min_minutes_between_applications)
       VALUES (?, ?, ?, ?, ?, 'IN', 'Tamil Nadu', 'Chennai', 'Asia/Kolkata', ?, ?, 'active', 'standard', 'form',
               NOW(3), 20, 5)`,
      [
        id, org.id, 'Demo Job Seeker', SEEKER_EMAIL, '+91-90000-00000',
        JSON.stringify(['Senior Backend Engineer', 'Node.js Developer']),
        JSON.stringify(['Node.js', 'TypeScript', 'MySQL', 'Azure', 'Docker']),
      ],
    );
    user = { id } as RowDataPacket & { id: string };
    console.log(`user          ${id}`);

    // Both consents on file, so the queue will actually hand out work for this account.
    for (const type of ['automated_apply', 'credential_storage', 'data_processing'] as const) {
      await execute(
        `INSERT INTO consents (id, user_id, consent_type, version, granted_at, captured_via, evidence_ref)
         VALUES (?, ?, ?, 'v1', NOW(3), 'seed', 'seed://demo-signed-form')`,
        [newId(), id, type],
      );
    }

    for (const company of ['Acme Technologies Pvt Ltd', 'Globex Corporation']) {
      await execute(
        `INSERT INTO excluded_companies (id, user_id, company_name, normalized_name, reason)
         VALUES (?, ?, ?, ?, 'current_employer')`,
        [newId(), id, company, normalizeCompany(company)],
      );
    }

    await execute(
      `INSERT INTO job_filters
         (id, user_id, name, designation, keywords, excluded_keywords, locations, remote_only,
          seniority, employment_types, portals, posted_within_days, priority)
       VALUES (?, ?, 'Backend roles', 'Senior Backend Engineer', ?, ?, ?, 0, 'senior', ?, ?, 14, 10)`,
      [
        newId(), id,
        JSON.stringify(['node.js', 'typescript', 'backend', 'api']),
        JSON.stringify(['unpaid', 'commission only']),
        JSON.stringify(['Chennai', 'Bengaluru', 'Remote']),
        JSON.stringify(['full_time', 'contract']),
        JSON.stringify(['linkedin', 'indeed', 'dice']),
      ],
    );
    console.log('filter        Backend roles');
  }

  const existingProxy = await queryOne<RowDataPacket>('SELECT id FROM proxies WHERE org_id = ? AND label = ?', [
    org.id,
    'IN-Chennai-1',
  ]);
  if (!existingProxy) {
    await execute(
      `INSERT INTO proxies (id, org_id, label, provider, kind, country, region, host, port, username, max_assignments)
       VALUES (?, ?, 'IN-Chennai-1', 'example-provider', 'residential', 'IN', 'Tamil Nadu', 'proxy.example.test', 8000, 'demo', 3)`,
      [newId(), org.id],
    );
    console.log('proxy         IN-Chennai-1');
  }

  console.log('\nSeed complete.');
  console.log('No portal credentials are seeded — add those through POST /users/:id/connections.');
}

seed()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
