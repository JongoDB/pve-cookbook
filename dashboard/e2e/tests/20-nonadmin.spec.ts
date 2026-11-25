import { test, expect, settle } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// A restricted PVE user (dev@pve: may see guest 121 only, no rights on "/").

test.use({ role: 'dev' });

test.describe('restricted user @fast', () => {
  test('sees only permitted guests and no admin pages', async ({ page }) => {
    await page.goto('/guests');
    await settle(page);
    const rows = page.getByRole('region', { name: 'Guest list' }).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('web02');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Hosts' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Add cluster' })).toHaveCount(0);
    await page.getByRole('button', { name: 'dev@pve' }).click();
    await expect(page.getByRole('menu', { name: 'Account' })).toContainText('Signed in with your PVE account');
    await page.keyboard.press('Escape');

    // the palette offers the same pages
    await page.keyboard.press('ControlOrMeta+k');
    const opts = page.getByRole('option');
    await expect(opts.filter({ hasText: /^Settings\s*Page$/ })).toHaveCount(0);
    await expect(opts.filter({ hasText: /^Hosts\s*Page$/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('admin pages explain themselves when opened directly', async ({ page, guard }) => {
    guard.allow({ method: 'GET', path: /^\/api\/clusters\/demo-lab\/hosts$/, status: 403, why: 'galley refuses host access to a non-admin; the page says so' });
    await page.goto('/settings');
    await expect(page.getByText('Settings need a galley admin')).toBeVisible();
    await page.goto('/hosts');
    await settle(page);
    await expect(page.locator('main')).toContainText('Host commands need administrator rights');
    await page.goto('/clusters');
    await settle(page);
    const c = page.getByRole('region', { name: CLUSTER, exact: true });
    await expect(c).toContainText('Logged in');
    await expect(c).not.toContainText('admin');
    await expect(c.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'Remove from galley' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add cluster' })).toHaveCount(0);
  });

  test('a guest it cannot see is reported as such', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120`);
    await expect(page.getByText(`No guest 120 on ${CLUSTER}`)).toBeVisible();
    await expect(page.locator('main')).toContainText('your PVE account cannot see it');
  });

  test('the console says which PVE permission is missing', async ({ page, guard }) => {
    guard.allow({ method: 'POST', path: /^\/api\/clusters\/demo-lab\/console$/, status: 403, why: 'PVE refuses dev@pve a console' });
    await page.goto(`/guests/${CLUSTER}/121`);
    await settle(page);
    await page.getByRole('link', { name: 'Console' }).click();
    await expect(page.getByRole('alert')).toContainText('PVE refused the console: it needs VM.Console on the guest');
    await expect(page.getByRole('alert').getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('hardware shows the mappings but no nodes it cannot see', async ({ page }) => {
    await page.goto('/hardware');
    await settle(page);
    await expect(page.getByRole('region', { name: 'PCI mappings' })).toContainText('gpu-a2-0');
    await expect(page.getByRole('region', { name: 'pve1' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check driver' })).toHaveCount(0); // host admins only
  });

  test('its changes run as itself', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/121`);
    await settle(page);
    await page.getByRole('toolbar', { name: 'Actions for web02' }).getByRole('button', { name: 'Reboot' }).click();
    const panel = page.getByRole('complementary', { name: 'Drawer' }).getByRole('tabpanel');
    await expect(panel).toContainText('runs as you (dev@pve)');
    await panel.getByRole('button', { name: 'Discard' }).click();
  });
});
