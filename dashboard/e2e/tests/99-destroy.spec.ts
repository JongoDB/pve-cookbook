import type { Page } from '@playwright/test';
import { test, expect, settle, applyChange, changes } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Guest list (filters, bulk actions) and the guest page (snapshot, hardware
// edit through the resource editor, migrate), each applied for real against
// the fake cluster.

const planRequest = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/plans');
const rowOf = (page: Page, name: string) => page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });

// Runs last: it really destroys guest 300, which earlier specs use.
test.describe('destroy @fast', () => {
  test('bulk destroy needs the typed confirmation', async ({ page }) => {
    await page.goto('/guests?q=llm');
    await settle(page);
    await page.getByRole('checkbox', { name: 'Select llm-vllm (300)' }).check();
    await page.getByRole('toolbar', { name: 'Actions for selected guests' }).getByRole('button', { name: 'Destroy' }).click();
    const panel = changes(page);
    await expect(panel.getByRole('note')).toBeVisible(); // why this change needs care
    // a running guest is stopped first; either way the last step destroys it
    const cli = await applyChange(page, { confirm: 'destroy 300' });
    expect(cli).toMatch(/(^|\n)qm destroy 300 --purge 1 --destroy-unreferenced-disks 1$/);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel.getByText('No change open')).toBeVisible();
    // the destroyed guest leaves the list promptly, not after the refresh throttle
    await expect(page.getByRole('checkbox', { name: 'Select llm-vllm (300)' })).toHaveCount(0, { timeout: 5000 });
    await page.goto(`/guests/${CLUSTER}/300`);
    await expect(page.getByText('No guest 300', { exact: false })).toBeVisible({ timeout: 5000 });
  });
});
