import type { Page } from '@playwright/test';
import { test, expect, settle, applyChange, changes } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Hardware (PCI mapping), Protection (add to a backup job), the API explorer
// (a read and a drafted write) and Hosts (a host command, applied, with its
// output in the audit log).

const planReq = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/plans');

test.describe('hardware @fast', () => {
  test('create a PCI mapping for an unmapped GPU', async ({ page }) => {
    await page.goto('/hardware');
    await settle(page);
    const maps = page.getByRole('region', { name: 'PCI mappings' });
    await expect(maps.getByRole('row').filter({ hasText: 'gpu-a2-0' })).toContainText('pve1 0000:16:00.0');
    await expect(maps.getByRole('row').filter({ hasText: 'gpu-a2-1' })).toBeVisible();
    const pve2 = page.getByRole('region', { name: 'pve2' });
    const gpu = pve2.getByRole('row').filter({ hasText: '0000:41:00.0' });
    await expect(gpu).toContainText('GPU');
    await gpu.getByRole('button', { name: 'Create mapping' }).click();
    const editor = pve2.locator('form.editor');
    await expect(editor.getByLabel('id', { exact: true })).not.toHaveValue('');
    await editor.getByLabel('id', { exact: true }).fill('gpu-l4-0');
    const req = planReq(page);
    await editor.getByRole('button', { name: 'Review change' }).click();
    const call = (await req).postDataJSON().params.calls[0];
    expect(call).toMatchObject({ method: 'POST', path: '/cluster/mapping/pci', body: { id: 'gpu-l4-0' } });
    expect(call.body.map).toContain('node=pve2,path=0000:41:00.0');
    const cli = await applyChange(page, { title: /Create PCI mapping/ });
    expect(cli).toMatch(/^pvesh create \/cluster\/mapping\/pci .*--id gpu-l4-0 --map node=pve2,path=0000:41:00.0/);
  });
});

test.describe('protection @fast', () => {
  test('add an unprotected guest to the backup job', async ({ page }) => {
    await page.goto('/protection');
    await settle(page);
    await expect(page.getByRole('region', { name: CLUSTER, exact: true })).toContainText('1 unprotected');
    const row = page.getByRole('row').filter({ hasText: 'grafana' });
    const req = planReq(page);
    await row.getByRole('button', { name: 'Add to nightly-all' }).click();
    expect((await req).postDataJSON()).toMatchObject({ action: 'backup.protect', clusterId: CLUSTER });
    const cli = await applyChange(page);
    expect(cli).toContain('/cluster/backup/nightly-all');
    await expect(page.getByRole('region', { name: `Backup jobs on ${CLUSTER}` })).toContainText('all guests except 131');
  });
});

test.describe('API explorer @fast', () => {
  test('search, read with GET, draft a PUT', async ({ page }) => {
    await page.goto('/api-explorer');
    await settle(page);
    await page.getByRole('searchbox', { name: 'Search API paths' }).fill('qemu config');
    await page.getByRole('button', { name: /^\/nodes\/\{node\}\/qemu\/\{vmid\}\/config/ }).click();
    await expect(page).toHaveURL(/path=%2Fnodes%2F%7Bnode%7D%2Fqemu%2F%7Bvmid%7D%2Fconfig&method=GET/);
    const detail = page.getByRole('region', { name: 'Selected path' });
    await expect(detail.getByLabel('{node}')).toHaveValue('pve1');
    await detail.getByLabel('{vmid}').fill('120');
    await expect(detail.locator('pre.cli').first()).toHaveText('pvesh get /nodes/pve1/qemu/120/config');
    await detail.getByRole('button', { name: 'Read it now' }).click();
    await expect(detail.getByLabel('Result')).toContainText('"name": "web01"');
    await detail.getByRole('button', { name: 'Copy JSON' }).click();
    await expect(detail.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"web01"');

    await detail.getByRole('group', { name: 'Method' }).getByRole('button', { name: 'PUT' }).click();
    await expect(page).toHaveURL(/method=PUT/);
    const editor = detail.locator('form.editor');
    await editor.getByLabel('memory').fill('16384');
    const req = planReq(page);
    await editor.getByRole('button', { name: 'Review change' }).click();
    expect((await req).postDataJSON().params.calls[0]).toMatchObject({ method: 'PUT', path: '/nodes/pve1/qemu/120/config', body: { memory: '16384' } });
    await expect(changes(page).locator('.change-title')).toHaveText('Change /nodes/pve1/qemu/120/config');
    await changes(page).getByRole('button', { name: 'Discard' }).click();
    await expect(changes(page).getByText('No change open')).toBeVisible();
  });

  test('a GET error is shown, not thrown', async ({ page, guard }) => {
    guard.allow({ method: 'GET', path: /^\/api\/clusters\/demo-lab\/pve\/nodes\/pve1\/qemu\/999\/config$/, status: 403, why: 'reading a guest that does not exist is the point' });
    await page.goto('/api-explorer?path=%2Fnodes%2F%7Bnode%7D%2Fqemu%2F%7Bvmid%7D%2Fconfig&method=GET');
    await settle(page);
    const detail = page.getByRole('region', { name: 'Selected path' });
    await detail.getByLabel('{vmid}').fill('999');
    await detail.getByRole('button', { name: 'Read it now' }).click();
    await expect(detail.getByRole('alert')).toContainText('PVE answered with an error');
  });
});

test.describe('hosts @fast', () => {
  test('a host command is drafted, confirmed by typing, applied, and its output kept', async ({ page }) => {
    await page.goto('/hosts');
    await settle(page);
    const pve1 = page.locator('li.host').filter({ hasText: 'pve1' });
    await pve1.getByRole('button', { name: 'Run a command' }).click();
    await pve1.getByLabel(/^Command/).fill('ethtool -a enp65s0f0');
    await pve1.getByLabel(/^Reason/).fill('e2e check of flow control');
    const req = planReq(page);
    await pve1.getByRole('button', { name: 'Review command' }).click();
    expect((await req).postDataJSON()).toMatchObject({ action: 'host.exec', clusterId: CLUSTER, params: { node: 'pve1', command: 'ethtool -a enp65s0f0', reason: 'e2e check of flow control' } });
    await expect(changes(page).getByRole('note')).toContainText('Runs as root on the node');
    await applyChange(page, { confirm: 'run on pve1' });
    await expect(changes(page).getByLabel('Command output')).toContainText('ran: ethtool -a enp65s0f0');

    await changes(page).getByRole('link', { name: 'Open audit log' }).click();
    await settle(page);
    const entry = page.getByRole('row').filter({ hasText: 'host.exec' }).first();
    await expect(entry.locator('.badge')).toHaveText('Done');
    await entry.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByLabel('Command output').first()).toContainText('ran: ethtool -a enp65s0f0');
  });
});
