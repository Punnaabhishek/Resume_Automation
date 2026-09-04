/**
 * Browser lifecycle. Two things here are load-bearing for not getting accounts flagged:
 * the persisted storageState (so a returning run looks like the same browser as last time)
 * and the per-user proxy (so it egresses from the user's own region rather than from a
 * datacentre IP shared by every account we run).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';
import { log } from './log.js';
import type { RunContext } from './api.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** storageState as of now, for POST /worker/runs/:id/session. */
  snapshot(): Promise<unknown>;
  close(): Promise<void>;
}

/** A stable, unremarkable desktop fingerprint. Randomising it per run would be the tell. */
const VIEWPORT = { width: 1440, height: 900 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * The platform is US-only, so the browser presents as a US client.
 *
 * The timezone is deliberately a real US zone rather than UTC: a browser reporting UTC from a
 * residential US IP is an obvious mismatch, and portal anti-abuse checks look at exactly that
 * pairing. UTC is how *we* store and reason about time; it is not what the browser should
 * claim to be. If a proxy region is known, its zone is used so the two agree.
 */
const US_ZONE_BY_REGION: Record<string, string> = {
  CA: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  CO: 'America/Denver',
  UT: 'America/Denver',
  AZ: 'America/Phoenix',
  TX: 'America/Chicago',
  IL: 'America/Chicago',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  GA: 'America/New_York',
  FL: 'America/New_York',
  NY: 'America/New_York',
  NJ: 'America/New_York',
  MA: 'America/New_York',
  PA: 'America/New_York',
  NC: 'America/New_York',
  VA: 'America/New_York',
  DC: 'America/New_York',
};

/** Intake stores full state names ("Texas"); this map is keyed by code, so translate. */
const STATE_CODES: Record<string, string> = {
  california: 'CA', washington: 'WA', oregon: 'OR', nevada: 'NV', colorado: 'CO',
  utah: 'UT', arizona: 'AZ', texas: 'TX', illinois: 'IL', minnesota: 'MN',
  missouri: 'MO', georgia: 'GA', florida: 'FL', 'new york': 'NY', 'new jersey': 'NJ',
  massachusetts: 'MA', pennsylvania: 'PA', 'north carolina': 'NC', virginia: 'VA',
  'district of columbia': 'DC',
};

function stateCode(state: string | null | undefined): string {
  const raw = (state ?? '').trim();
  if (raw.length === 2) return raw.toUpperCase();
  return STATE_CODES[raw.toLowerCase()] ?? '';
}

function localeFor(region: string | null | undefined): { locale: string; timezoneId: string } {
  const key = (region ?? '').trim().toUpperCase();
  return { locale: 'en-US', timezoneId: US_ZONE_BY_REGION[key] ?? 'America/New_York' };
}

async function loadStorageState(ctx: RunContext): Promise<unknown | undefined> {
  const rel = ctx.connection.sessionStatePath;
  if (!rel) return undefined;
  // The API hands back a path relative to its storage root. Worker and API share a volume
  // in the compose deployment; when they do not, this read simply misses and we log in fresh.
  const root = process.env.STORAGE_ROOT ? path.resolve(process.env.STORAGE_ROOT) : path.resolve('../storage');
  const abs = path.resolve(root, rel);
  try {
    const raw = await fs.promises.readFile(abs, 'utf8');
    log.info('reusing stored browser session', { path: rel });
    return JSON.parse(raw);
  } catch {
    log.info('no reusable session on disk; will log in fresh', { path: rel });
    return undefined;
  }
}

export async function openSession(ctx: RunContext, proxyPassword?: string): Promise<Session> {
  const storageState = await loadStorageState(ctx);
  const { locale, timezoneId } = localeFor(stateCode(ctx.user.state));

  const proxy = ctx.connection.proxy
    ? {
        server: `http://${ctx.connection.proxy.host}:${ctx.connection.proxy.port}`,
        username: ctx.connection.proxy.username ?? undefined,
        password: proxyPassword,
        // Loopback should never leave the machine. Without this a configured proxy also
        // swallows local traffic, which breaks the offline e2e and would hide a
        // misconfigured proxy behind a confusing connection error in production.
        bypass: 'localhost,127.0.0.1,::1',
      }
    : undefined;

  if (proxy) log.info('routing through user proxy', { host: ctx.connection.proxy!.host, country: ctx.connection.proxy!.country });
  else log.warn('no proxy on this connection; egressing from the worker host directly');

  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    locale,
    ...(timezoneId ? { timezoneId } : {}),
    ...(proxy ? { proxy } : {}),
    ...(storageState ? { storageState: storageState as never } : {}),
  });

  context.setDefaultTimeout(config.actionTimeoutMs);
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);

  // navigator.webdriver is the single cheapest automation tell to remove. This is not a
  // full stealth stack and is not presented as one.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    snapshot: () => context.storageState(),
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

export async function screenshot(page: Page, name: string): Promise<string | undefined> {
  try {
    await fs.promises.mkdir(config.screenshotDir, { recursive: true });
    const file = path.join(config.screenshotDir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch (err) {
    log.warn('screenshot failed', { error: (err as Error).message });
    return undefined;
  }
}
