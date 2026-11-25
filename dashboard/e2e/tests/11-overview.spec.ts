import { test, expect, settle } from '../lib/fixtures';

// The overview's own layout: add and remove widgets, persisted per user.

test.describe('overview layout @fast', () => {
  test('add and remove widgets, change the time range; it persists after reload', async ({ page, guard }) => {
    await page.goto('/');
    await settle(page);
    const widget = (name: string) => page.locator('main section.w').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(widget('Running tasks')).toHaveCount(0);
    await expect(widget('Recent changes')).toHaveCount(1);

    await page.getByRole('button', { name: 'Edit layout' }).click();
    const catalog = page.getByRole('complementary', { name: 'Add a widget' });
    await catalog.getByRole('searchbox', { name: 'Search widgets' }).fill('tasks');
    await expect(catalog.locator('.ci')).toHaveCount(1);
    await catalog.getByRole('button', { name: 'Add Running tasks' }).click();
    await expect(catalog.getByRole('button', { name: 'Running tasks is on the dashboard' })).toBeDisabled();
    await expect(widget('Running tasks')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove Recent changes' }).click();
    await expect(widget('Recent changes')).toHaveCount(0);
    // keyboard arrangement
    await page.getByRole('button', { name: 'Move Running tasks earlier' }).click();
    await expect(page.locator('[aria-live="polite"].sr-only')).toContainText('Running tasks moved to position');
    const save = page.waitForResponse((r) => r.url().endsWith('/api/prefs/dashboard') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Done' }).click();
    expect((await save).status()).toBe(204);
    await page.getByRole('group', { name: 'Time range for charts' }).getByRole('button', { name: '30 d' }).click();
    await page.waitForResponse((r) => r.url().endsWith('/api/prefs/dashboard') && r.request().method() === 'PUT');

    await page.reload();
    await settle(page);
    await expect(widget('Running tasks')).toHaveCount(1);
    await expect(widget('Recent changes')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '30 d' })).toHaveAttribute('aria-pressed', 'true');
    const titles = await page.locator('main section.w h2').allInnerTexts();
    expect(titles.indexOf('Running tasks')).toBe(titles.length - 2);

    // back to the default for the other tests
    await page.getByRole('button', { name: 'Edit layout' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: '24 h' }).click(); // the default range (reset keeps the range)
    await page.waitForResponse((r) => r.url().endsWith('/api/prefs/dashboard') && r.request().method() === 'PUT');
    await page.reload();
    await settle(page);
    await expect(widget('Recent changes')).toHaveCount(1);
    await expect(widget('Running tasks')).toHaveCount(0);
    guard.check();
  });

  test('a metric chart can be configured', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Edit layout' }).click();
    await page.getByRole('button', { name: 'Choose what Node CPU shows' }).click();
    const form = page.getByRole('form', { name: 'Chart settings' });
    await form.getByLabel('Show').selectOption('guest');
    await form.getByLabel('web01 (120)').check();
    await form.getByLabel('Title').fill('web01 CPU');
    await form.getByRole('button', { name: 'Save chart' }).click();
    await expect(page.getByRole('heading', { name: 'web01 CPU' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'Node CPU' })).toBeVisible();
  });

  test('a finding with a fix opens it in Changes', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    // Backup coverage offers the fix for the guest without a backup
    const backups = page.locator('main section.w').filter({ has: page.getByRole('heading', { name: 'Backup coverage' }) });
    await backups.getByRole('button', { name: 'Review fix' }).first().click();
    const panel = page.getByRole('complementary', { name: 'Drawer' }).getByRole('tabpanel');
    await expect(panel.locator('.change-title')).not.toBeEmpty();
    await panel.getByRole('button', { name: 'Discard' }).click();
    await expect(panel.getByText('No change open')).toBeVisible();
  });
});
