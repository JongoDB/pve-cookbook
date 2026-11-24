import { test, expect, loginUI, settle } from '../lib/fixtures';
import { CLUSTER, USERS } from '../lib/env';

// Login, logout, an ended session and a lapsed cluster login.

test.describe('authentication @fast', () => {
  test.use({ role: 'anon' });

  test('wrong password is refused, right one logs in, log out returns to login', async ({ page, guard }) => {
    guard.allow({ method: 'POST', path: /^\/api\/login$/, status: 401, why: 'the wrong password is part of this test' });
    guard.allow({ method: 'GET', path: /^\/api\/me$/, status: 401, why: 'the boot probe before login' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Log in to galley' })).toBeAttached();
    await expect(page.getByLabel('Cluster')).toHaveValue(CLUSTER);
    await page.getByLabel('User name').fill('root');
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: `Log in to ${CLUSTER}` }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong user name, realm or password');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');

    await loginUI(page, USERS.root);
    await settle(page);
    await expect(page.locator('main h1')).toHaveText('Overview');
    // What's new may greet a user once; root saw it in global setup
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'root@pam' }).click();
    await expect(page.getByRole('menu', { name: 'Account' })).toContainText('galley admin');
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page.getByRole('button', { name: /^Log in/ })).toBeVisible();
    // the session is really gone
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(401);
    // and a reload stays on the login page
    await page.reload();
    await expect(page.getByRole('button', { name: /^Log in/ })).toBeVisible();
  });

  test('a session that ends elsewhere sends the page back to login with a notice', async ({ page, guard }) => {
    guard.allow({ path: /^\/api\//, status: 401, why: 'the session is ended on purpose' });
    guard.allow({ method: 'GET', path: /^\/api\/events$/, why: 'the event stream drops when the session ends' });
    await loginUI(page, USERS.root);
    await settle(page);
    // log out with the same cookie from outside the page (another tab)
    const csrf = (await (await page.request.get('/api/me')).json()).csrf;
    expect((await page.request.post('/api/logout', { headers: { 'X-Galley-CSRF': csrf, 'Content-Type': 'application/json' }, data: '{}' })).status()).toBe(204);
    // the next request from the page (navigation reads, polling) notices
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('status').filter({ hasText: /session (ended|expired)|log in again/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Log in/ })).toBeVisible();
    await loginUI(page, USERS.root);
  });
});

test.describe('lapsed cluster login @fast', () => {
  test('the notice offers a cluster login that restores the session', async ({ page }) => {
    // A PVE ticket that lapsed while galley's session stayed valid (TestLapsedClusterLogin
    // covers the server side). The fake cluster's tickets never expire, so the first
    // /api/me answer is altered to report the lapse; the login itself is real.
    let patched = false;
    await page.route('**/api/me', async (route) => {
      const res = await route.fetch();
      if (patched) { await route.fulfill({ response: res }); return; }
      patched = true;
      const me = await res.json();
      me.clusters = me.clusters.map((c: Record<string, unknown>) => ({ ...c, authed: false, loginExpired: true }));
      await route.fulfill({ response: res, json: me });
    });
    await page.goto('/hardware');
    const notice = page.getByRole('status').filter({ hasText: `Your login to ${CLUSTER} lapsed` });
    await expect(notice).toBeVisible();
    await expect(page.locator('main')).toContainText(`Log in to ${CLUSTER}`);
    await notice.getByRole('button', { name: `Log in to ${CLUSTER}` }).click();
    await notice.getByLabel(/Password/).fill(USERS.root.password);
    const login = page.waitForResponse((r) => r.url().endsWith(`/api/clusters/${CLUSTER}/login`));
    await notice.getByRole('button', { name: /Log in/ }).click();
    expect((await login).status()).toBe(200);
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'PCI mappings' })).toBeVisible();
  });
});
