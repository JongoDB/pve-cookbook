import { test, expect, settle, loginUI } from '../lib/fixtures';
import { USERS } from '../lib/env';

// Settings: the assistant switch (with the regression from 15e6853), feedback,
// and the What's new dialog.

test.describe('settings: assistant @fast', () => {
  test('a key saved with the box unticked keeps it off; ticking turns the open drawer into a chat', async ({ page }) => {
    await page.goto('/settings');
    await settle(page);
    const form = page.getByRole('form', { name: 'Assistant' });
    const enabled = form.getByRole('checkbox', { name: 'Turn on the assistant for every galley user' });
    await expect(enabled).not.toBeChecked();
    await expect(form.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute('aria-checked', 'true');

    // the drawer stays open on the Assistant tab while settings change
    await page.getByRole('button', { name: 'Open Assistant' }).click();
    const drawer = page.getByRole('complementary', { name: 'Drawer' });
    await expect(drawer).toContainText('The assistant is not set up yet');

    // 1. paste a key, leave the box unticked, save
    await form.getByLabel('API key').fill('sk-ant-e2e-not-a-real-key');
    await expect(form.getByRole('note')).toContainText('A key is entered, but the assistant is off');
    const put = page.waitForRequest((r) => r.url().endsWith('/api/settings/assistant') && r.method() === 'PUT');
    await form.getByRole('button', { name: 'Save assistant settings' }).click();
    expect((await put).postDataJSON()).toMatchObject({ enabled: false, provider: 'anthropic', apiKey: 'sk-ant-e2e-not-a-real-key' });
    await expect(form.getByRole('status')).toHaveText('Saved. The assistant is off.');
    await expect(form.getByText('A key is saved', { exact: true })).toBeVisible();
    await expect(drawer).toContainText('The assistant is set up but turned off');
    await expect(drawer.getByRole('link', { name: 'Turn on the assistant' })).toBeVisible();

    // 2. tick the box and save: the drawer becomes the chat without a reload
    await enabled.check();
    await form.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(form.getByRole('status')).toContainText('Saved. The assistant uses these settings');
    await expect(drawer.getByRole('textbox', { name: 'Message the assistant' })).toBeVisible();
    await expect(drawer).toContainText('claude-opus-5-5');
    await expect(form.locator('.panel-head')).toContainText('On, Anthropic');

    // 3. switch it off again
    await enabled.uncheck();
    await form.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(drawer).toContainText('The assistant is set up but turned off');

    // Anthropic without a key cannot be turned on; Undo restores the saved form
    await form.getByRole('button', { name: 'Remove key' }).click();
    await enabled.check();
    await form.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(form.getByRole('alert')).toContainText('Anthropic needs an API key');
    await form.getByRole('button', { name: 'Undo changes' }).click();
    await expect(enabled).not.toBeChecked();
    await expect(form.getByText('A key is saved', { exact: true })).toBeVisible();

    // switching the provider drops the key for the new destination
    await form.getByRole('radio', { name: 'OpenAI-compatible' }).click();
    await form.getByRole('button', { name: 'http://<host>:11434/v1' }).click();
    await expect(form.getByLabel('Base URL')).toHaveValue('http://<host>:11434/v1');
    await expect(form).toContainText('the saved key will not be sent there');
    await expect(form).toContainText('This endpoint uses plain HTTP');
    await form.getByRole('button', { name: 'Undo changes' }).click();

    // it is all in the audit log
    await page.goto('/audit');
    await settle(page);
    await expect(page.getByRole('row').filter({ hasText: 'settings.assistant' })).toHaveCount(3);
  });
});

test.describe('settings: feedback @fast', () => {
  test('feedback opens a pre-filled GitHub issue', async ({ page }) => {
    // capture window.open instead of leaving the page
    await page.addInitScript(() => {
      (window as unknown as { opened: unknown[] }).opened = [];
      window.open = (...a: unknown[]) => { (window as unknown as { opened: unknown[] }).opened.push(a); return null; };
    });
    await page.goto('/settings');
    await settle(page);
    const form = page.getByRole('form', { name: 'Feedback' });
    await form.getByLabel('GitHub repository').fill('not a repo');
    await form.getByRole('checkbox', { name: 'Let users send feedback' }).check();
    await form.getByRole('button', { name: 'Save feedback settings' }).click();
    await expect(form.getByRole('alert')).toContainText('owner/name');
    await form.getByLabel('GitHub repository').fill('https://github.com/example-org/galley-e2e/');
    await form.getByRole('button', { name: 'Save feedback settings' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved. Send feedback opens new issues on example-org/galley-e2e.');

    await page.goto('/guests');
    await settle(page);
    await page.getByRole('button', { name: 'root@pam' }).click();
    await page.getByRole('menuitem', { name: 'Send feedback' }).click();
    const dlg = page.getByRole('dialog', { name: 'Send feedback' });
    await expect(dlg).toContainText('Issues on example-org/galley-e2e are public');
    await expect(dlg.getByLabel('Title')).toBeFocused();
    await dlg.getByRole('button', { name: 'Continue on GitHub' }).click();
    await expect(dlg.getByRole('alert')).toHaveText('Enter a title.');
    await dlg.getByRole('radio', { name: 'Idea' }).click();
    await dlg.getByLabel('Title').fill('Sort guests by memory');
    await dlg.getByLabel("What you'd like").fill('A sortable memory column.');
    await dlg.getByRole('button', { name: 'Continue on GitHub' }).click();
    await expect(dlg).toHaveCount(0);
    const opened = await page.evaluate(() => (window as unknown as { opened: [string, string, string][] }).opened);
    expect(opened).toHaveLength(1);
    const [href, target, features] = opened[0];
    expect(target).toBe('_blank');
    expect(features).toContain('noopener');
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://github.com/example-org/galley-e2e/issues/new');
    expect(u.searchParams.get('title')).toBe('Sort guests by memory');
    expect(u.searchParams.get('labels')).toBe('enhancement');
    const body = u.searchParams.get('body')!;
    expect(body).toContain("### What you'd like\nA sortable memory column.");
    expect(body).toContain('- page: /guests');
    expect(body).toMatch(/- galley v?\S+/);

    // the palette offers it too; then switch feedback off again
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Ask, search or run a command' }).fill('feedback');
    await expect(page.getByRole('option', { name: /^Send feedback/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/settings');
    await settle(page);
    await form.getByRole('checkbox', { name: 'Let users send feedback' }).uncheck();
    await form.getByRole('button', { name: 'Save feedback settings' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved. Send feedback is hidden.');
    await page.getByRole('button', { name: 'root@pam' }).click();
    await expect(page.getByRole('menuitem', { name: 'Send feedback' })).toHaveCount(0);
  });
});

test.describe("what's new @fast", () => {
  test.use({ role: 'anon' });

  test('shows once after login, not again after Got it and a reload', async ({ page, guard }) => {
    guard.allow({ method: 'GET', path: /^\/api\/me$/, status: 401, why: 'the boot probe before login' });
    // ops@pve has never logged in to this galley
    await loginUI(page, USERS.ops);
    const dlg = page.getByRole('dialog', { name: /^What's new in galley/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.release-date')).toContainText('Released');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/prefs/whatsnew') && r.request().method() === 'PUT');
    await dlg.getByRole('button', { name: 'Got it' }).click();
    expect((await saved).status()).toBe(204);
    await expect(dlg).toHaveCount(0);
    await page.reload();
    await settle(page);
    await page.waitForTimeout(800); // the check runs after load
    await expect(dlg).toHaveCount(0);
    // it can still be opened by hand, from Help
    await page.goto('/help');
    await page.getByRole('button', { name: "What's new" }).click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  });
});
