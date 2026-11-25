import { test, expect, settle } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Route sweep as a restricted user (dev@pve): pages render and explain what
// the account cannot see instead of failing.

test.use({ role: 'dev' });

const ROUTES = ['/', '/guests', `/guests/${CLUSTER}/121`, '/nodes', '/storage', '/protection', '/activity', '/audit', '/clusters',
  '/create', '/hardware', '/api-explorer', '/agents', '/help', `/console/${CLUSTER}/node/pve1`];

test.describe('route sweep, restricted user @fast', () => {
  for (const path of ROUTES) {
    test(`loads ${path}`, async ({ page, guard }) => {
      guard.allow({ method: 'POST', path: /^\/api\/clusters\/demo-lab\/console$/, status: 403, why: 'PVE refuses dev@pve a node shell; the page says so' });
      await page.goto(path);
      await settle(page);
      await expect(page).toHaveURL(path);
      if (path === '/create') await expect(page.locator('main')).toContainText('No online node of demo-lab is visible to you');
      if (path.startsWith('/console/')) await expect(page.getByRole('alert')).toContainText('it needs Sys.Console');
      await page.waitForTimeout(400);
      guard.check(path);
    });
  }
});
