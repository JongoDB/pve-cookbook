import { test as base, expect, type Page, type Response, type TestInfo } from '@playwright/test';
import { STATE, type Role } from './env';

/**
 * API answers that are part of normal operation and must not fail a test.
 * Keep this short; every entry needs a reason. Tests add their own expected
 * errors with guard.allow().
 */
const ALLOWED: { method: string; path: RegExp; status: number; why: string }[] = [
  { method: 'GET', path: /^\/api\/prefs\/(dashboard|whatsnew)$/, status: 404, why: 'an unset preference answers 404; the UI then uses its default' },
];

interface Allowed { method?: string; path: RegExp; status?: number; why: string }

/**
 * Watches a page for anything that went wrong: uncaught exceptions, console
 * errors, failed network requests and galley API answers of 400 or more. The
 * test fails at the end if any of them happened and was not expected.
 */
export class Guard {
  problems: string[] = [];
  private allowed: Allowed[] = [];
  private consoleAllowed: RegExp[] = [];

  constructor(public page: Page) {
    page.on('pageerror', (e) => this.problems.push(`uncaught exception: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // The browser logs every 4xx/5xx; those are judged by status below.
      if (/^Failed to load resource: the server responded with a status of/.test(t)) return;
      if (this.consoleAllowed.some((r) => r.test(t))) return;
      this.problems.push(`console error: ${t}`);
    });
    page.on('requestfailed', (r) => {
      const err = r.failure()?.errorText ?? '';
      // Navigation and unmounts abort requests (the event stream, in-flight reads): not failures.
      if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(err)) return;
      this.problems.push(`request failed: ${r.method()} ${r.url()} (${err})`);
    });
    page.on('response', (r) => this.onResponse(r));
  }

  private onResponse(r: Response) {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') && u.pathname !== '/mcp') return;
    if (r.status() < 400) return;
    const m = r.request().method();
    const hit = (a: { method?: string; path: RegExp; status?: number }) =>
      (!a.method || a.method === m) && a.path.test(u.pathname) && (!a.status || a.status === r.status());
    if (ALLOWED.some(hit) || this.allowed.some(hit)) return;
    this.problems.push(`HTTP ${r.status()} for ${m} ${u.pathname}${u.search}`);
  }

  /** Expect an API error in this test (say why). */
  allow(a: Allowed) { this.allowed.push(a); }
  /** Expect a console error matching re in this test. */
  allowConsole(re: RegExp) { this.consoleAllowed.push(re); }

  /** Fail now if anything went wrong so far (also runs after every test). */
  check(where = '') {
    const p = this.problems.splice(0);
    expect(p, `problems${where ? ` on ${where}` : ''}`).toEqual([]);
  }
}

type Fixtures = { guard: Guard; role: Role | 'anon' };

export const test = base.extend<Fixtures>({
  role: ['root', { option: true }],
  storageState: async ({ role }, use) => { await use(role === 'anon' ? { cookies: [], origins: [] } : STATE(role)); },
  guard: [async ({ page }, use, testInfo: TestInfo) => {
    const g = new Guard(page);
    await use(g);
    if (testInfo.status === testInfo.expectedStatus) g.check();
    else if (g.problems.length) await testInfo.attach('page problems', { body: g.problems.join('\n'), contentType: 'text/plain' });
  }, { auto: true }],
});

export { expect };

/** Wait until a galley page has rendered its main heading and nothing is loading. */
export async function settle(page: Page) {
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('main h1').first(), 'the page failed to render').not.toHaveText('Something went wrong');
  await expect(page.locator('main [role="status"]:text-matches("^(Loading|Connecting|Checking)", "i")')).toHaveCount(0, { timeout: 10_000 });
}

/** Log in through the login page. */
export async function loginUI(page: Page, u: { username: string; realm: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('User name').fill(u.username);
  await expect(page.getByLabel('Realm')).toBeEnabled();
  await page.getByLabel('Realm').selectOption(u.realm);
  await page.getByLabel('Password', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: /^Log in/ }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/** The drawer's Changes panel. */
export const changes = (page: Page) => page.getByRole('complementary', { name: 'Drawer' }).getByRole('tabpanel');

/**
 * Apply the change open in Changes (typing its confirmation when it has one)
 * and wait until galley reports it applied. Returns the change's commands.
 */
export async function applyChange(page: Page, opts: { confirm?: string; title?: RegExp | string } = {}): Promise<string> {
  const panel = changes(page);
  await expect(page.getByRole('tab', { name: /^Changes/, selected: true })).toBeVisible();
  await expect(panel.locator('.change-title')).toBeVisible({ timeout: 10_000 });
  if (opts.title) await expect(panel.locator('.change-title')).toHaveText(opts.title);
  const cli = (await panel.getByLabel('Commands this change runs').count()) ? await panel.getByLabel('Commands this change runs').innerText() : '';
  const apply = panel.getByRole('button', { name: 'Apply change' });
  if (opts.confirm) {
    await expect(apply).toBeDisabled();
    const field = panel.getByLabel(/^Type .* to confirm$/);
    await field.fill(opts.confirm.slice(0, -1));
    await expect(apply).toBeDisabled();
    await field.fill(opts.confirm);
  } else {
    await expect(panel.getByLabel(/^Type .* to confirm$/)).toHaveCount(0);
  }
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(panel.getByRole('status').filter({ hasText: 'Change applied. It is in the audit log.' })).toBeVisible({ timeout: 20_000 });
  return cli;
}
