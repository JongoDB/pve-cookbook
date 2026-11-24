import type { Page } from '@playwright/test';
import { test, expect, settle, applyChange, changes } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Guest list (filters, bulk actions) and the guest page (snapshot, hardware
// edit through the resource editor, migrate), each applied for real against
// the fake cluster.

const planRequest = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/plans');
const rowOf = (page: Page, name: string) => page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });

test.describe('guest list @fast', () => {
  test('search, tag and status filters narrow the list', async ({ page }) => {
    await page.goto('/guests');
    await settle(page);
    const rows = page.getByRole('region', { name: 'Guest list' }).locator('tbody tr');
    await expect(rows).toHaveCount(4); // the template is not listed
    await page.getByRole('searchbox', { name: 'Search guests' }).fill('web');
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL(/\?q=web/);
    await page.getByRole('searchbox', { name: 'Search guests' }).fill('');
    await page.getByRole('button', { name: 'Filter by tag monitoring' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('grafana');
    await page.getByRole('searchbox', { name: 'Search guests' }).fill('');
    await page.getByLabel('Status').selectOption('stopped');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('llm-vllm');
    await page.getByLabel('Status').selectOption('');
    await page.getByLabel('Type').selectOption('lxc');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Type').selectOption('');
    await page.getByRole('searchbox', { name: 'Search guests' }).fill('zzz-nothing');
    await expect(page.getByText('No guests match')).toBeVisible();
  });

  test('bulk start: select, review in Changes, apply, guest runs, audit shows ok', async ({ page }) => {
    await page.goto('/guests');
    await settle(page);
    const toolbar = page.getByRole('toolbar', { name: 'Actions for selected guests' });
    await expect(toolbar.getByRole('button', { name: 'Start' })).toBeDisabled();
    await page.getByLabel('Status').selectOption('stopped');
    await page.getByRole('checkbox', { name: 'Select llm-vllm (300)' }).check();
    await expect(toolbar).toContainText('1 selected');
    const req = planRequest(page);
    await toolbar.getByRole('button', { name: 'Start' }).click();
    expect((await req).postDataJSON()).toEqual({ action: 'guest.start', clusterId: CLUSTER, params: { targets: [{ vmid: 300, node: 'pve1', type: 'qemu' }] } });
    const cli = await applyChange(page, { title: /Start/ });
    expect(cli).toBe('qm start 300');
    await changes(page).getByRole('button', { name: 'Close' }).click();
    // the fleet shows the guest running on the next poll
    await page.getByLabel('Status').selectOption('running');
    await expect(rowOf(page, 'llm-vllm')).toContainText('running', { timeout: 15_000 });

    await page.goto('/audit');
    await settle(page);
    const entry = page.getByRole('row').filter({ hasText: 'guest.start' }).first();
    await expect(entry.locator('.badge')).toHaveText('Done');
    await entry.getByRole('button', { name: 'Details' }).click();
    await expect(page.locator('pre.cli').first()).toHaveText('qm start 300');
  });
});

test.describe('guest page @fast', () => {
  test('tabs and history time range', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120`);
    await settle(page);
    for (const t of ['Hardware', 'Options', 'Snapshots', 'Task history', 'Summary']) {
      await page.getByRole('tab', { name: t }).click();
      await expect(page.getByRole('tab', { name: t })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(new RegExp(`tab=${t === 'Task history' ? 'tasks' : t.toLowerCase()}`));
    }
    await page.getByRole('tab', { name: 'Snapshots' }).click();
    await expect(page.getByText('pre-upgrade')).toBeVisible();
    await page.getByRole('tab', { name: 'Task history' }).click();
    await expect(page.getByRole('cell', { name: 'qmstart' })).toBeVisible();
    // the summary charts reload for another time range
    await page.getByRole('tab', { name: 'Summary' }).click();
    const metrics = page.waitForRequest((r) => r.url().includes('/api/metrics') && (r.postData() ?? r.url()).includes('week'));
    await page.getByRole('group', { name: 'Time range for charts' }).getByRole('button', { name: '7 d' }).click();
    await metrics;
    await expect(page.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('snapshot', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120?tab=snapshots`);
    await settle(page);
    await page.getByRole('button', { name: 'Take snapshot' }).click();
    let drafted = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/plans')) drafted++; });
    await page.getByLabel('Snapshot name').fill('1bad'); // must start with a letter
    await page.getByRole('button', { name: 'Review snapshot' }).click();
    await expect(page.getByLabel('Snapshot name')).toBeVisible(); // the browser refused the pattern
    expect(await page.getByLabel('Snapshot name').evaluate((e: HTMLInputElement) => e.validity.patternMismatch)).toBe(true);
    expect(drafted).toBe(0);
    await page.getByLabel('Snapshot name').fill('e2e-snap');
    await page.getByLabel('Description (optional)').fill('before e2e');
    const req = planRequest(page);
    await page.getByRole('button', { name: 'Review snapshot' }).click();
    expect((await req).postDataJSON().params).toMatchObject({ name: 'e2e-snap', description: 'before e2e' });
    const cli = await applyChange(page);
    expect(cli).toBe("qm snapshot 120 e2e-snap --description 'before e2e'");
  });

  test('hardware edit sends only the changed key through the resource editor', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120?tab=hardware`);
    await settle(page);
    await page.getByRole('button', { name: 'Edit Processors' }).click();
    const editor = page.locator('form.editor');
    await expect(editor.getByLabel('cores')).toHaveValue('4');
    await editor.getByLabel('cores').fill('6');
    await expect(editor.locator('pre.cli')).toContainText('--cores 6');
    const req = planRequest(page);
    await editor.getByRole('button', { name: 'Review change' }).click();
    const body = (await req).postDataJSON();
    expect(body.action).toBe('api.call');
    expect(body.params.calls).toEqual([{ method: 'PUT', path: '/nodes/pve1/qemu/120/config', body: { cores: '6', digest: 'f00d120' } }]);
    await expect(editor).toHaveCount(0);
    const cli = await applyChange(page);
    expect(cli).toContain('pvesh set /nodes/pve1/qemu/120/config');
    expect(cli).toContain('--cores 6');

    // adding a device: the menu offers the device families
    await page.getByRole('button', { name: 'Add device' }).click();
    await page.getByRole('menuitem', { name: 'Network device' }).click();
    await expect(page.locator('form.editor').getByText('net1', { exact: true })).toBeVisible();
    await page.locator('form.editor').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('form.editor')).toHaveCount(0);
  });

  test('migrate lists the other nodes and moves the VM live', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120`);
    await settle(page);
    await page.getByRole('toolbar', { name: 'Actions for web01' }).getByRole('button', { name: 'Migrate' }).click();
    const target = page.getByLabel('Move web01 from pve1 to');
    await expect(target.locator('option')).toHaveText(['pve2', 'pve3']);
    await target.selectOption('pve3');
    const req = planRequest(page);
    await page.getByRole('button', { name: 'Review migration' }).click();
    expect((await req).postDataJSON().params).toMatchObject({ target: 'pve3', online: true });
    expect(await applyChange(page)).toBe('qm migrate 120 pve3 --online');
  });
});
