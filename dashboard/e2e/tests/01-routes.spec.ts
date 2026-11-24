import { test, expect, settle } from '../lib/fixtures';
import { REDIRECTS, ROUTES } from '../lib/routes';

// 1. Route sweep: every route loads with its heading and without errors.

test.describe('route sweep @fast', () => {
  for (const r of ROUTES) {
    test(`loads ${r.path}`, async ({ page, guard }) => {
      await page.goto(r.path);
      await settle(page);
      await expect(page.locator('main h1').first()).toHaveText(r.h1);
      const want = new URL(r.path, 'http://x');
      expect(new URL(page.url()).pathname, 'stayed on the route (not redirected)').toBe(want.pathname);
      // a page body, not only a heading
      expect((await page.locator('main').innerText()).length).toBeGreaterThan(40);
      if (r.path.startsWith('/console/')) {
        await expect(page.getByRole('status').filter({ hasText: /Connecting|Asking PVE/ })).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('main .notice-error')).toHaveCount(0);
      }
      // give late requests (charts, polling) a moment to fail
      await page.waitForTimeout(400);
      guard.check(r.path);
    });
  }

  for (const r of REDIRECTS) {
    test(`redirects ${r.from} to ${r.to}`, async ({ page }) => {
      await page.goto(r.from);
      await expect(page).toHaveURL((u) => u.pathname === r.to);
      await settle(page);
    });
  }
});
