import type { Page } from '@playwright/test';
import { test, expect, settle } from '../lib/fixtures';
import { ROUTES, routeKnown } from '../lib/routes';

// 2. Link crawl: every internal link on every page (navigation, breadcrumbs,
// help links, Markdown links in help pages, the drawer) leads to a page that
// renders, and every #anchor exists.

async function linksOn(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href')!)
    .filter((h) => h.startsWith('/') || h.startsWith('#')));
}

async function idsOn(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
}

test.describe('link crawl @slow', () => {
  test.setTimeout(240_000);

  test('every internal link renders a page and every anchor exists', async ({ page, guard }) => {
    const found = new Map<string, string>(); // href -> first page it was seen on
    const helpIds = new Map<string, string[]>(); // help slug -> element ids on that page
    const add = (hrefs: string[], from: string) => {
      for (const h of hrefs) {
        const abs = h.startsWith('#') ? `${new URL(from, 'http://x').pathname}${h}` : h;
        if (!found.has(abs)) found.set(abs, from);
      }
    };

    // pages: every route, plus every help page (their Markdown links)
    const docs = await (await page.request.get('/api/docs')).json() as { slug: string }[];
    expect(docs.length).toBeGreaterThan(10);
    const pages = [...ROUTES.map((r) => r.path), ...docs.map((d) => `/help/${d.slug}`)];
    for (const p of new Set(pages)) {
      await page.goto(p);
      await settle(page);
      add(await linksOn(page), p);
      const m = /^\/help\/([^/?#]+)$/.exec(p);
      if (m) helpIds.set(m[1], await idsOn(page));
      guard.check(p);
    }

    // the drawer's panels link to help and to Activity
    await page.goto('/');
    await settle(page);
    for (const tab of ['Changes', 'Activity', 'Assistant']) {
      await page.getByRole('button', { name: `Open ${tab}` }).or(page.getByRole('tab', { name: tab })).first().click();
      await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
      add(await linksOn(page), '/');
    }
    await page.getByRole('button', { name: 'Fold the drawer' }).click();

    expect(found.size).toBeGreaterThan(60);
    const broken: string[] = [];
    const visited = new Set<string>();
    for (const [href, from] of found) {
      const u = new URL(href, 'http://x');
      // help pages and their anchors: checked against the pages already rendered
      const hm = /^\/help\/([^/]+)$/.exec(u.pathname);
      if (hm) {
        const ids = helpIds.get(decodeURIComponent(hm[1]));
        if (!ids) broken.push(`${href} (on ${from}): no such help page`);
        else if (u.hash && !ids.includes(decodeURIComponent(u.hash.slice(1)))) broken.push(`${href} (on ${from}): no anchor ${u.hash}`);
        continue;
      }
      if (!routeKnown(u.pathname)) { broken.push(`${href} (on ${from}): no such route`); continue; }
      const key = u.pathname + u.search;
      if (visited.has(key) && !u.hash) continue;
      visited.add(key);
      await page.goto(href);
      await settle(page);
      const at = new URL(page.url());
      if (at.pathname !== u.pathname && !(u.pathname === '/operations' && at.pathname === '/activity')) {
        broken.push(`${href} (on ${from}): ended at ${at.pathname}`);
        continue;
      }
      const empty = await page.locator('main .empty strong').filter({ hasText: /^No (guest \d|such|help page called)/ }).count();
      if (empty) broken.push(`${href} (on ${from}): page says ${await page.locator('main .empty strong').first().innerText()}`);
      if (u.hash) {
        const id = decodeURIComponent(u.hash.slice(1));
        const ids = await idsOn(page);
        // /clusters#<id> scrolls to the section "cluster-<id>"
        if (!ids.includes(id) && !ids.includes(`cluster-${id}`)) broken.push(`${href} (on ${from}): no anchor ${u.hash}`);
      }
      guard.check(href);
    }
    expect(broken).toEqual([]);
    console.log(`links: ${found.size}, visited: ${visited.size}`);
    test.info().annotations.push({ type: 'links', description: `${found.size} links checked, ${visited.size} pages visited` });
  });
});
