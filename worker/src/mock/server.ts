/**
 * A fake job portal, good enough to exercise every branch the real adapters have to handle:
 * a login form, a device-verification OTP step, paginated search, an apply button, and an
 * applied-jobs view for status sync.
 *
 * This exists because the LinkedIn/Indeed/Dice adapters cannot be tested without real
 * accounts and real applications sent to real employers. The orchestration in run.ts is
 * portal-independent, so testing it against this proves the loop — claim, login, OTP,
 * match, apply, record, pace, finish — without touching anyone's account.
 */
import http from 'node:http';
import { URL } from 'node:url';

export interface MockOptions {
  port: number;
  /** Credentials the mock will accept. */
  email: string;
  password: string;
  /** When true, the first login attempt is answered with a device-verification prompt. */
  requireOtp: boolean;
  /** The code the OTP form accepts. */
  otpCode: string;
  jobs: MockJob[];
}

export interface MockJob {
  id: string;
  title: string;
  company: string;
  location: string;
  snippet: string;
  /** The full posting. Must be substantial: the matcher scores zero on a stub. */
  description: string;
}

const SESSION_COOKIE = 'mockportal_session';
const PENDING_COOKIE = 'mockportal_pending';

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export interface MockServer {
  url: string;
  /** Job ids the mock actually received a submission for. The ground truth for the e2e. */
  applied: string[];
  close(): Promise<void>;
}

export function startMockPortal(options: MockOptions): Promise<MockServer> {
  const applied: string[] = [];
  const PAGE_SIZE = 5;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
    const jar = cookies(req);
    const loggedIn = jar[SESSION_COOKIE] === 'ok';

    const send = (status: number, html: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };

    // --- login ---------------------------------------------------------------
    if (url.pathname === '/login' && req.method === 'GET') {
      send(
        200,
        page(
          'Sign in',
          `<h1>Sign in</h1>
           <form method="post" action="/login">
             <input id="username" name="username" type="email" placeholder="Email">
             <input id="password" name="password" type="password" placeholder="Password">
             <button type="submit" id="signin">Sign in</button>
           </form>`,
        ),
      );
      return;
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      const form = await readBody(req);
      const ok = form.get('username') === options.email && form.get('password') === options.password;
      if (!ok) {
        send(200, page('Sign in', '<h1>Sign in</h1><p class="error">That password is incorrect.</p>'));
        return;
      }
      if (options.requireOtp) {
        send(302, '', { location: '/checkpoint', 'set-cookie': `${PENDING_COOKIE}=1; Path=/` });
        return;
      }
      send(302, '', { location: '/jobs', 'set-cookie': `${SESSION_COOKIE}=ok; Path=/` });
      return;
    }

    // --- device verification -------------------------------------------------
    if (url.pathname === '/checkpoint' && req.method === 'GET') {
      if (!jar[PENDING_COOKIE]) {
        send(302, '', { location: '/login' });
        return;
      }
      send(
        200,
        page(
          'Verification',
          `<h1>Enter the verification code</h1>
           <p>We sent a code to your device.</p>
           <form method="post" action="/checkpoint">
             <input id="verification-code" name="code" placeholder="Code">
             <button type="submit" id="verify">Verify</button>
           </form>`,
        ),
      );
      return;
    }

    if (url.pathname === '/checkpoint' && req.method === 'POST') {
      const form = await readBody(req);
      if (form.get('code') !== options.otpCode) {
        send(200, page('Verification', '<h1>Enter the verification code</h1><p class="error">That code is not valid.</p>'));
        return;
      }
      send(302, '', {
        location: '/jobs',
        'set-cookie': [`${SESSION_COOKIE}=ok; Path=/`, `${PENDING_COOKIE}=; Path=/; Max-Age=0`],
      });
      return;
    }

    // Everything past here needs a session.
    if (!loggedIn) {
      send(302, '', { location: '/login' });
      return;
    }

    // --- search --------------------------------------------------------------
    if (url.pathname === '/jobs') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const start = Number(url.searchParams.get('start') ?? '0');
      // Any-token match, which is roughly how the real portals behave: a multi-word query
      // broadens the result set rather than requiring every word.
      const tokens = q.split(/\s+/).filter(Boolean);
      const matches = options.jobs.filter((j) => {
        if (!tokens.length) return true;
        const haystack = `${j.title} ${j.snippet}`.toLowerCase();
        return tokens.some((t) => haystack.includes(t));
      });
      const slice = matches.slice(start, start + PAGE_SIZE);
      const cards = slice
        .map(
          (j) => `<li class="job-card" data-job-id="${j.id}">
              <a class="job-title" href="/job/${j.id}">${j.title}</a>
              <span class="job-company">${j.company}</span>
              <span class="job-location">${j.location}</span>
              <span class="job-snippet">${j.snippet}</span>
            </li>`,
        )
        .join('');
      send(200, page('Jobs', `<h1>Results</h1><ul id="results">${cards}</ul>`));
      return;
    }

    // --- job detail + apply --------------------------------------------------
    const detail = url.pathname.match(/^\/job\/([\w-]+)$/);
    if (detail && req.method === 'GET') {
      const job = options.jobs.find((j) => j.id === detail[1]);
      if (!job) {
        send(404, page('Not found', '<h1>No such job</h1>'));
        return;
      }
      const done = applied.includes(job.id);
      send(
        200,
        page(
          job.title,
          `<h1 class="job-title">${job.title}</h1>
           <div class="job-company">${job.company}</div>
           <div class="job-location">${job.location}</div>
           <div class="job-description">${job.description}</div>
           ${
             done
               ? '<div class="applied-state">Applied</div>'
               : `<form method="post" action="/job/${job.id}/apply">
                    <button id="easy-apply" type="submit">Easy Apply</button>
                  </form>`
           }`,
        ),
      );
      return;
    }

    const applyRoute = url.pathname.match(/^\/job\/([\w-]+)\/apply$/);
    if (applyRoute && req.method === 'POST') {
      const id = applyRoute[1]!;
      if (!applied.includes(id)) applied.push(id);
      send(200, page('Applied', '<h1 class="application-submitted">Your application was sent</h1>'));
      return;
    }

    // --- applied-jobs view, for status sync ----------------------------------
    if (url.pathname === '/my/applied') {
      const rows = applied
        .map((id) => {
          const job = options.jobs.find((j) => j.id === id);
          // Deterministic pseudo-status so the e2e can assert on it.
          const status = id.endsWith('2') ? 'viewed' : 'applied';
          return `<li class="applied-row" data-job-id="${id}" data-status="${status}">${job?.title ?? id}</li>`;
        })
        .join('');
      send(200, page('Applied', `<ul id="applied-list">${rows}</ul>`));
      return;
    }

    send(404, page('Not found', '<h1>Not found</h1>'));
  });

  return new Promise((resolve) => {
    server.listen(options.port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${options.port}`,
        applied,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

export const SAMPLE_JOBS: MockJob[] = [
  {
    id: 'mock-1',
    title: 'Senior Backend Engineer',
    company: 'Northwind Technologies Inc.',
    location: 'Remote — United States',
    snippet: 'Node.js TypeScript MySQL',
    description: "We are hiring a Senior Backend Engineer to own our core services platform. You will design, build and operate production APIs serving millions of requests a day. Responsibilities: build and maintain backend services in Node.js and TypeScript; model and evolve data in MySQL with Redis for caching; deploy and operate services with Docker and Kubernetes on AWS; design event-driven flows; build REST and GraphQL APIs for web and mobile clients; mentor engineers and lead technical design for distributed systems. Requirements: 5+ years of professional backend engineering experience, deep knowledge of Node.js, TypeScript and relational databases, production experience with Kubernetes and AWS, strong grounding in microservices. Our stack is Node.js, TypeScript, MySQL, Redis, Docker, Kubernetes and AWS.",
  },
  {
    id: 'mock-2',
    title: 'Backend Engineer',
    company: 'Contoso Corp',
    location: 'Austin, TX, United States',
    snippet: 'Node.js distributed systems',
    description: "We are hiring a Senior Backend Engineer to own our core services platform. You will design, build and operate production APIs serving millions of requests a day. Responsibilities: build and maintain backend services in Node.js and TypeScript; model and evolve data in MySQL with Redis for caching; deploy and operate services with Docker and Kubernetes on AWS; design event-driven flows; build REST and GraphQL APIs for web and mobile clients; mentor engineers and lead technical design for distributed systems. Requirements: 5+ years of professional backend engineering experience, deep knowledge of Node.js, TypeScript and relational databases, production experience with Kubernetes and AWS, strong grounding in microservices. We work in Node.js and TypeScript on MySQL, Redis, Docker, Kubernetes and AWS.",
  },
  {
    id: 'mock-3',
    title: 'Backend Engineer, Payments',
    company: 'Blocked Industries Inc',
    location: 'Remote — United States',
    snippet: 'Node.js payments',
    description: "We are hiring a Senior Backend Engineer to own our core services platform. You will design, build and operate production APIs serving millions of requests a day. Responsibilities: build and maintain backend services in Node.js and TypeScript; model and evolve data in MySQL with Redis for caching; deploy and operate services with Docker and Kubernetes on AWS; design event-driven flows; build REST and GraphQL APIs for web and mobile clients; mentor engineers and lead technical design for distributed systems. Requirements: 5+ years of professional backend engineering experience, deep knowledge of Node.js, TypeScript and relational databases, production experience with Kubernetes and AWS, strong grounding in microservices. Payments domain, built on Node.js, TypeScript, MySQL, Redis, Docker and AWS.",
  },
  {
    id: 'mock-4',
    title: 'Unpaid Backend Internship',
    company: 'Fabrikam',
    location: 'Remote — United States',
    snippet: 'internship node.js',
    description: "A summer internship for students interested in backend engineering fundamentals. You will work with Node.js and TypeScript alongside a mentor, learning how production services are built, tested and deployed with Docker on AWS. We use MySQL and Redis. No prior professional experience is required; this is an entry level position intended for those currently enrolled in a degree programme. You will pair with engineers, review code, and ship small improvements to internal tooling over twelve weeks.",
  },
  {
    id: 'mock-5',
    title: 'Backend Engineer, Platform',
    company: 'Tailwind Traders',
    location: 'Denver, CO, United States',
    snippet: 'Node.js platform',
    description: "We are hiring a Senior Backend Engineer to own our core services platform. You will design, build and operate production APIs serving millions of requests a day. Responsibilities: build and maintain backend services in Node.js and TypeScript; model and evolve data in MySQL with Redis for caching; deploy and operate services with Docker and Kubernetes on AWS; design event-driven flows; build REST and GraphQL APIs for web and mobile clients; mentor engineers and lead technical design for distributed systems. Requirements: 5+ years of professional backend engineering experience, deep knowledge of Node.js, TypeScript and relational databases, production experience with Kubernetes and AWS, strong grounding in microservices. Platform team using Node.js, TypeScript, MySQL, Redis, Kubernetes and AWS.",
  },
  {
    id: 'mock-6',
    title: 'Senior Frontend Designer',
    company: 'Adventure Works',
    location: 'Remote — United States',
    snippet: 'design systems figma',
    description: "We are looking for a Senior Frontend Designer to own our design system end to end. You will create high-fidelity mockups in Figma, run user research sessions, and partner with product managers on visual direction, brand, typography and motion design. You will define colour palettes, illustration style and accessibility standards across the product. Requirements: 5+ years in product design or visual design, expert with Figma, Sketch and prototyping tools, a portfolio demonstrating strong visual craft and interaction design, and experience running usability studies and synthesising findings.",
  },
];
