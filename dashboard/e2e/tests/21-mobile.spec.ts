import type { Page } from '@playwright/test';
import { test, expect, settle } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Phone width (375 px): pages fit, the menu and the drawer work.

test.use({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'page scrolls sideways').toBeLessThanOrEqual(1);
}

test.describe('mobile @fast', () => {
  test('overview fits and the menu navigates', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await noSideScroll(page);
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: /^Guests/ }).first()).not.toBeInViewport();
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await nav.getByRole('link', { name: /^Guests/ }).first().click();
    await expect(page).toHaveURL('/guests');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    await settle(page);
  });

  test('guest page fits and its tabs work', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120`);
    await settle(page);
    await noSideScroll(page);
    await page.getByRole('tab', { name: 'Hardware' }).click();
    await expect(page.getByRole('heading', { name: 'Hardware' })).toBeVisible();
    await noSideScroll(page);
  });

  test('drawer opens over the page and Escape folds it', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Open Changes' }).click();
    const drawer = page.getByRole('complementary', { name: 'Drawer' });
    await expect(drawer.getByText('No change open')).toBeInViewport();
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await expect(drawer.getByRole('heading', { name: 'Finished' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open Changes' })).toBeVisible();
  });
});
