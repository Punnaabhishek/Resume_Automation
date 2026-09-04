/**
 * Calibration checks for the matcher. No database, no network.
 *
 * These assert *ordering and thresholds*, not exact numbers — the point is that a strong fit
 * clears the bar, a wrong-role posting cannot, and an unreadable description scores zero
 * rather than sailing through. Exact scores are allowed to move as the weights are tuned;
 * these relationships are not.
 *
 *   npx tsx scripts/match-check.ts
 */
import assert from 'node:assert/strict';
import { MIN_ALLOWED_MATCH_SCORE, scoreMatch, thresholdFor, type ResumeProfile } from '../src/services/matching';

const resume: ResumeProfile = {
  rawText: [
    'Dana Whitfield — Senior Backend Engineer, Austin TX',
    '',
    'Summary',
    'Senior backend engineer with 8 years building and operating production APIs,',
    'distributed services and data pipelines on AWS. Deep experience with Node.js and',
    'TypeScript, relational data modelling in PostgreSQL and MySQL, containerised',
    'deployment with Docker and Kubernetes, and event-driven architecture with Kafka.',
    '',
    'Experience',
    'Acme Corp — Senior Backend Engineer (2021-present)',
    '  Owned billing and entitlements services in Node.js and TypeScript. Designed the',
    '  PostgreSQL schema, ran migrations, and operated the services on Kubernetes in AWS.',
    '  Built REST and GraphQL APIs consumed by web and mobile clients. Mentored engineers.',
    'Globex Inc — Backend Engineer (2018-2021)',
    '  Built the internal reporting API and its ETL pipeline. Redis caching, CI/CD, testing.',
    '',
    'Skills',
    'Node.js, TypeScript, JavaScript, PostgreSQL, MySQL, Redis, Docker, Kubernetes, AWS,',
    'Kafka, REST, GraphQL, CI/CD, microservices, distributed systems',
  ].join('\n'),
  skills: [
    'Node.js', 'TypeScript', 'PostgreSQL', 'MySQL', 'Redis', 'Docker', 'Kubernetes', 'AWS',
    'Kafka', 'GraphQL', 'React', 'Python',
  ],
  yearsExperience: 8,
  targetDesignations: ['Senior Backend Engineer', 'Backend Engineer'],
};

const strongJob = {
  title: 'Senior Backend Engineer',
  company: 'Northwind Technologies',
  description: [
    'We are hiring a Senior Backend Engineer to own our core services platform.',
    'You will design, build and operate production APIs used by millions of requests a day.',
    '',
    'What you will do',
    '- Build and maintain backend services in Node.js and TypeScript',
    '- Model and evolve data in PostgreSQL, with Redis for caching',
    '- Deploy and operate services with Docker and Kubernetes on AWS',
    '- Design event-driven flows using Kafka',
    '- Build REST and GraphQL APIs for web and mobile clients',
    '- Mentor engineers and lead technical design for distributed systems',
    '',
    'What we are looking for',
    '- 5+ years of professional backend engineering experience',
    '- Deep knowledge of Node.js, TypeScript and relational databases',
    '- Production experience with Kubernetes and AWS',
    '- Strong grounding in microservices and distributed systems',
  ].join('\n'),
};

const wrongRoleJob = {
  title: 'Senior Frontend Designer',
  company: 'Contoso',
  description: [
    'We are looking for a Senior Frontend Designer to own our design system.',
    'You will create high-fidelity mockups in Figma, run user research sessions, and',
    'partner with product managers on visual direction, brand, typography and motion.',
    'You will define colour palettes, illustration style and accessibility standards.',
    '',
    'Requirements',
    '- 5+ years in product design or visual design',
    '- Expert with Figma, Sketch and prototyping tools',
    '- A portfolio demonstrating strong visual craft and interaction design',
    '- Experience running usability studies and synthesising research findings',
  ].join('\n'),
};

const wrongSeniorityJob = {
  title: 'Backend Engineering Intern',
  company: 'Fabrikam',
  description: [
    'A summer internship for students interested in backend engineering.',
    'You will work with Node.js and TypeScript alongside a mentor, learning how',
    'production services are built, tested and deployed with Docker on AWS.',
    'We use PostgreSQL and Redis. No prior professional experience required;',
    'this is an entry level position for those currently enrolled in a degree.',
    'You will pair with engineers, review code and ship small improvements.',
  ].join('\n'),
};

const partialJob = {
  title: 'Backend Engineer',
  company: 'Tailwind Traders',
  description: [
    'Backend Engineer wanted to work on our payments platform.',
    'You will build services in Python and Django, backed by PostgreSQL.',
    'Experience with Kubernetes and AWS is valuable. We run a microservices',
    'architecture and care deeply about reliability, testing and observability.',
    'You will collaborate with product and design to ship customer-facing features.',
    '',
    'Requirements',
    '- 4+ years of backend engineering experience',
    '- Strong Python skills; Django or FastAPI experience preferred',
    '- Comfortable operating services in production',
  ].join('\n'),
};

const checks: { name: string; run: () => void }[] = [];
const check = (name: string, run: () => void) => checks.push({ name, run });

const strong = scoreMatch(resume, strongJob);
const wrongRole = scoreMatch(resume, wrongRoleJob);
const wrongSeniority = scoreMatch(resume, wrongSeniorityJob);
const partial = scoreMatch(resume, partialJob);

check('a genuinely strong fit clears a 95 bar', () => {
  assert.equal(strong.unscorable, null);
  assert.ok(
    strong.score >= 95,
    `strong fit scored ${strong.score}, below the 95 bar — components: ${JSON.stringify(
      strong.components.map((c) => [c.key, c.score.toFixed(2)]),
    )}`,
  );
});

check('a wrong-role posting cannot clear the floor', () => {
  assert.ok(
    wrongRole.score < MIN_ALLOWED_MATCH_SCORE,
    `frontend design role scored ${wrongRole.score}, at or above the ${MIN_ALLOWED_MATCH_SCORE} floor`,
  );
});

check('an internship cannot pass for a senior role', () => {
  assert.ok(
    wrongSeniority.score < MIN_ALLOWED_MATCH_SCORE,
    `internship scored ${wrongSeniority.score}, at or above the ${MIN_ALLOWED_MATCH_SCORE} floor`,
  );
});

check('a partial fit scores below a strong one', () => {
  assert.ok(
    partial.score < strong.score,
    `partial (${partial.score}) did not score below strong (${strong.score})`,
  );
});

check('missing skills are named, not just counted', () => {
  assert.ok(partial.missingSkills.length > 0, 'expected Python-heavy posting to name unmet skills');
  assert.ok(
    partial.missingSkills.some((s) => /python/i.test(s)),
    `expected Python among missing skills, got ${partial.missingSkills.join(', ')}`,
  );
});

check('an unreadable description scores zero rather than passing', () => {
  const empty = scoreMatch(resume, { title: 'Senior Backend Engineer', company: 'X', description: '' });
  assert.equal(empty.score, 0, 'an empty description must not score above zero');
  assert.ok(empty.unscorable, 'an empty description must say why it could not be scored');

  const stub = scoreMatch(resume, {
    title: 'Senior Backend Engineer',
    company: 'X',
    description: 'Node.js TypeScript PostgreSQL Kubernetes AWS Kafka GraphQL Redis Docker',
  });
  assert.equal(stub.score, 0, 'a keyword stub below the length floor must not score');
});

check('every component is explainable', () => {
  for (const c of strong.components) {
    assert.ok(c.label && c.detail, `component ${c.key} is missing its explanation`);
    assert.ok(c.score >= 0 && c.score <= 1, `component ${c.key} scored outside 0-1: ${c.score}`);
  }
});

check('the threshold is floored regardless of what a user asks for', () => {
  assert.equal(thresholdFor(50), MIN_ALLOWED_MATCH_SCORE, 'a low user threshold must be floored');
  assert.equal(thresholdFor(null), 95);
  assert.equal(thresholdFor(97), 97);
  assert.equal(thresholdFor(200), 100);
});

check('scoring is deterministic', () => {
  const again = scoreMatch(resume, strongJob);
  assert.equal(again.score, strong.score, 'the same inputs produced different scores');
});

let passed = 0;
let failed = false;
for (const c of checks) {
  try {
    c.run();
    passed += 1;
    console.log(`  ok    ${c.name}`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL  ${c.name}`);
    console.error(`        ${(err as Error).message}`);
  }
}

console.log('');
console.log('  scores:');
for (const [label, result] of [
  ['strong fit        ', strong],
  ['partial fit       ', partial],
  ['wrong seniority   ', wrongSeniority],
  ['wrong role        ', wrongRole],
] as const) {
  console.log(
    `    ${label} ${String(result.score).padStart(3)}  ${result.components
      .map((c) => `${c.key}=${Math.round(c.score * 100)}`)
      .join(' ')}`,
  );
}

console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
