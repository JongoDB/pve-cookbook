import type { Page } from '@playwright/test';
import { test, expect, settle } from '../lib/fixtures';
import { ROUTES } from '../lib/routes';

// 3. Button sweep: on every page, click every visible, enabled button, tab,
// menu item and disclosure that does not change anything (menus, tabs,
// segmented controls, dialogs, time ranges, Edit layout, copy buttons, drawer
// tabs, folding). Buttons that draft, apply or delete are exercised with
// their real flows in the other spec files instead.

/** Names of controls the sweep must not press (they change state; see the flow tests). */
const SKIP = new RegExp([
  '^(Destroy|Remove|Revoke|Delete|Unpin|Log out|Apply|Discard|Reset to default|Send|Start|Shut down|Reboot|Stop)\\b',
  'Review', '^Save', 'Create token', 'Rename cluster', '^Pin ', '^Add to ', 'Delete the key', '^Run$', '^Log in',
  '^Add (?!device$)', '^Move .* (earlier|later)$', '^Change width', '^Choose what', 'Use the LLM server preset',
  '^Keep', '^Check driver', '^Check on ', '^Done, I copied', '^Read host key', 'Try again', 'Take snapshot',
].join('|'));

const CANDIDATES = 'button, [role="tab"], [role="menuitem"], [role="radio"]:not(input), summary';

/** Tag the controls that are visible now; returns their new ids and names. */
async function tag(page: Page, start: number): Promise<{ id: number; name: string }[]> {
  return page.evaluate(({ sel, start }) => {
    const out: { id: number; name: string }[] = [];
    let n = start;
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.dataset.sweep || el.closest('.sidenav')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
      el.dataset.sweep = String(n);
      out.push({ id: n++, name: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ') });
    }
    return out;
  }, { sel: CANDIDATES, start });
}

async function closeOverlays(page: Page) {
  // "Full screen" (consoles) covers the page until it is left
  await page.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : undefined));
  for (let i = 0; i < 3; i++) {
    const open = page.locator('[role="dialog"], .palette-backdrop, [role="menu"]');
    if (!(await open.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  // a dialog without Escape handling still has to close somehow
  const close = page.locator('[role="dialog"]').getByRole('button', { name: /^(Close|Cancel|Got it)$/ });
  if (await close.count()) await close.first().click();
  await expect(page.locator('[role="dialog"], .palette-backdrop')).toHaveCount(0);
}

test.describe('button sweep @slow', () => {
  test.setTimeout(120_000);
  for (const r of ROUTES) {
    test(`buttons on ${r.path}`, async ({ page, guard }) => {
      await page.goto(r.path);
      await settle(page);
      const path = new URL(page.url()).pathname;
      const clicked: string[] = [];
      let next = 0;
      for (let pass = 0; pass < 3; pass++) {
        const controls = await tag(page, next);
        next += controls.length + 1;
        if (!controls.length) break;
        for (const c of controls) {
          if (SKIP.test(c.name)) continue;
          const el = page.locator(`[data-sweep="${c.id}"]`);
          if (!(await el.count()) || !(await el.isVisible()) || !(await el.isEnabled())) continue;
          await el.click({ timeout: 5_000 }).catch((e) => { throw new Error(`could not click "${c.name}": ${String(e).split('\n')[0]}`); });
          clicked.push(c.name);
          await page.waitForTimeout(120);
          await closeOverlays(page);
          if (new URL(page.url()).pathname !== path) {
            await page.goBack();
            await settle(page);
          }
          await expect(page.locator('main h1').first(), `page still renders after "${c.name}"`).toBeVisible();
          guard.check(`${r.path} after "${c.name}"`);
        }
      }
      test.info().annotations.push({ type: 'clicked', description: `${clicked.length}: ${clicked.join(' | ')}` });
      console.log(`${r.path}: clicked ${clicked.length}`);
      expect(clicked.length).toBeGreaterThan(0);
    });
  }
});
