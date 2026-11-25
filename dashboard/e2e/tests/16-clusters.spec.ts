import { test, expect, settle } from '../lib/fixtures';
import { CLUSTER, USERS } from '../lib/env';

// Clusters: add a second cluster (the same fake PVE, registered again), log
// in to it, rename it, see it across the UI, and remove it.

// The fake cluster's read-only service token (internal/fakepve: TokenID, Secret).
const TOKEN_ID = 'galley@pve!poller';
const TOKEN_SECRET = '11111111-2222-3333-4444-555555555555';

test.describe('clusters @slow', () => {
  test('add, log in, rename and remove a cluster', async ({ page, guard }) => {
    const clusters = await (await page.request.get('/api/clusters')).json() as { id: string; endpoints: { host: string }[] }[];
    const host = clusters.find((c) => c.id === CLUSTER)!.endpoints[0].host;

    await page.goto('/clusters');
    await settle(page);
    await page.getByRole('button', { name: 'Add cluster' }).click();
    await expect(page).toHaveURL(/\/clusters\?add=1/);
    const add = page.getByRole('region', { name: 'Add a cluster' });
    await add.getByLabel(/^API endpoints/).fill(host);
    await add.getByRole('button', { name: 'Probe endpoints' }).click();
    await add.getByRole('checkbox', { name: `Trust ${host}` }).check();
    await add.getByLabel('Cluster name').fill('lab2');
    await add.getByLabel(/^Service token ID/).fill(TOKEN_ID);
    await add.getByLabel('Token secret').fill(TOKEN_SECRET);
    await add.getByRole('button', { name: 'Add cluster with 1 endpoint' }).click();
    await expect(page).toHaveURL(/\/clusters$/);

    const lab2 = page.getByRole('region', { name: 'lab2', exact: true });
    await expect(lab2).toContainText('Not logged in');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: /^lab2/ })).toContainText('log in');
    // galley admin needs a login to every cluster: Settings disappears until then
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);

    await lab2.getByLabel(/Password/).fill(USERS.root.password);
    await lab2.getByRole('button', { name: /^Log in/ }).click();
    await expect(lab2).toContainText('Logged in, admin');
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^lab2/ })).toContainText('3 of 3', { timeout: 15_000 });

    // two clusters: lists offer a cluster filter
    await page.goto('/guests');
    await settle(page);
    await page.getByLabel('Cluster').selectOption({ label: 'lab2' });
    await expect(page).toHaveURL(/cluster=/);
    await expect(page.getByRole('region', { name: 'Guest list' }).locator('tbody tr')).toHaveCount(4);

    await page.goto('/clusters');
    await settle(page);
    await lab2.getByRole('button', { name: 'Rename' }).click();
    await lab2.getByLabel('New name for lab2').fill('lab-two');
    await lab2.getByRole('button', { name: 'Rename cluster' }).click();
    const renamed = page.getByRole('region', { name: 'lab-two', exact: true });
    await expect(renamed).toBeVisible();
    await expect(nav.getByRole('link', { name: /^lab-two/ })).toBeVisible();
    // the sidebar link jumps to the cluster's section
    await nav.getByRole('link', { name: /^lab-two/ }).click();
    await expect(page).toHaveURL(/\/clusters#/);

    await renamed.getByRole('button', { name: 'Remove from galley' }).click();
    const confirm = renamed.getByRole('button', { name: 'Remove lab-two' });
    await expect(confirm).toBeDisabled();
    await renamed.getByLabel(/^Type lab-two to remove/).fill('lab-two');
    await confirm.click();
    await expect(renamed).toHaveCount(0);
    await expect(nav.getByRole('link', { name: /^lab-two/ })).toHaveCount(0);

    // all of it is in the audit log
    await page.goto('/audit');
    await settle(page);
    for (const a of ['cluster.delete', 'cluster.update', 'cluster.add']) {
      await expect(page.getByRole('row').filter({ hasText: a }).first()).toBeVisible();
    }
    guard.check();
  });
});
