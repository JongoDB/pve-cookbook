import { test, expect, settle } from '../lib/fixtures';
import { PAGES_FOR_ADMIN } from '../lib/pages';

// Help search and the command palette (⌘K / Ctrl+K).

test.describe('help @fast', () => {
  test('search finds pages by text; a page has contents, anchors and neighbours', async ({ page, guard }) => {
    guard.allow({ method: 'GET', path: /^\/api\/docs\/no-such-page$/, status: 404, why: 'an unknown help page is part of this test' });
    await page.goto('/help');
    await settle(page);
    await page.getByRole('searchbox', { name: 'Search help' }).fill('snapshot');
    await expect(page).toHaveURL(/\/help\?q=snapshot/);
    const cards = page.locator('.help-cards a');
    await expect(cards.first()).toBeVisible();
    await expect(page.locator('.help-cards')).toContainText('Guests');
    await page.getByRole('searchbox', { name: 'Search help' }).fill('zzzz-nothing-matches');
    await expect(page.getByText('No help page matches')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search help' }).fill('');

    await page.goto('/help/guests');
    await settle(page);
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await toc.getByRole('link', { name: 'Take a snapshot' }).click();
    await expect(page).toHaveURL(/#take-a-snapshot$/);
    await expect(page.locator('#take-a-snapshot')).toBeFocused();
    await expect(page.locator('#take-a-snapshot')).toBeInViewport();
    await page.getByRole('link', { name: 'Open this page in galley' }).click();
    await expect(page).toHaveURL('/guests');
    await page.goBack();
    await page.getByRole('navigation', { name: 'Other help pages' }).getByRole('link', { name: /^Next/ }).click();
    await expect(page).toHaveURL(/\/help\/(?!guests)/);
    // an unknown page says so
    await page.goto('/help/no-such-page');
    await expect(page.getByText('No help page called no-such-page')).toBeVisible();
  });
});

test.describe('command palette @fast', () => {
  test('opens with the shortcut and every page entry navigates', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const input = page.getByRole('combobox', { name: 'Ask, search or run a command' });
    for (const p of PAGES_FOR_ADMIN) {
      await page.keyboard.press('ControlOrMeta+k');
      await expect(input).toBeFocused();
      await page.getByRole('option', { name: new RegExp(`^${p.label}\\s*Page$`) }).click();
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
      await expect(page).toHaveURL(p.to);
      await settle(page);
    }
  });

  test('finds guests, nodes, storage and help; drafts a command; Escape closes', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: /^Ask, search or run a command/ }).click();
    const input = page.getByRole('combobox', { name: 'Ask, search or run a command' });
    await input.fill('grafana');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/guests/demo-lab/131');

    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('pve2');
    await page.getByRole('option', { name: /^pve2\s*Node/ }).click();
    await expect(page).toHaveURL('/nodes/demo-lab/pve2');

    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('vm-pool');
    await page.getByRole('option', { name: /^vm-pool\s*Storage/ }).click();
    await expect(page).toHaveURL('/storage/demo-lab/vm-pool');

    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('local pve3');
    await page.getByRole('option', { name: /^local on pve3/ }).click();
    await expect(page).toHaveURL('/storage/demo-lab/local%40pve3');
    await settle(page);

    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('consoles');
    await page.getByRole('option', { name: /^Help: Consoles/ }).click();
    await expect(page).toHaveURL('/help/consoles');

    // arrow keys move the selection (the pointer is kept off the list: hovering selects too)
    await page.mouse.move(0, 0);
    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('web');
    // help page text loads after the first keystroke and can add results: let the list settle
    await expect.poll(async () => { const n = await page.getByRole('option').count(); await page.waitForTimeout(250); return n === await page.getByRole('option').count(); }).toBe(true);
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);

    // a command: preview, then Enter opens it in Changes
    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('reboot 121');
    await expect(page.locator('.palette-preview pre')).toHaveText('qm reboot 121');
    await page.keyboard.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Drawer' }).getByRole('tabpanel');
    await expect(panel.locator('.change-title')).toContainText('121');
    await panel.getByRole('button', { name: 'Discard' }).click();

    // a mistyped command explains itself
    await page.keyboard.press('ControlOrMeta+k');
    await input.fill('start 99999');
    await expect(page.locator('.palette-err')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
