import { request } from '@playwright/test';
import { test, expect, settle } from '../lib/fixtures';
import { baseURL } from '../lib/env';

// Agents: create a read token in the UI, use it against /mcp from outside the
// browser, revoke it, and see it refused.

test.describe('agents and MCP @fast', () => {
  test('create a read token, use it over MCP, revoke it', async ({ page }) => {
    await page.goto('/agents');
    await settle(page);
    const create = page.getByRole('region', { name: 'Create a token' });
    await expect(create.getByRole('button', { name: 'Create token' })).toBeDisabled();
    await create.getByLabel('Name').fill('e2e agent');
    await expect(create.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
    await create.getByLabel('Name').fill('e2e-agent');
    await create.getByLabel('Days valid').fill('2');
    await create.getByRole('radio', { name: /^apply:/ }).check();
    await expect(create.getByRole('note')).toContainText('An apply token can change your clusters');
    await create.getByRole('radio', { name: /^read:/ }).check();
    await create.getByRole('button', { name: 'Create token' }).click();

    const fresh = page.getByRole('region', { name: 'Token for e2e-agent' });
    const token = (await fresh.getByLabel('Agent token').innerText()).trim();
    expect(token).toMatch(/^glly_/);
    await expect(fresh).toContainText('Works on demo-lab');
    await fresh.getByRole('button', { name: 'Copy token' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
    await expect(fresh.locator('pre.snippet-cli').first()).toContainText(`${new URL(page.url()).origin}/mcp --header "Authorization: Bearer ${token}"`);
    await fresh.getByRole('button', { name: 'Done, I copied it' }).click();
    const row = page.getByRole('region', { name: 'Your agent tokens' }).getByRole('row').filter({ hasText: 'e2e-agent' });
    await expect(row).toContainText('read');
    await expect(row.getByRole('cell').nth(3)).toHaveText('Never'); // last used

    // an MCP client, outside the browser
    const mcp = await request.newContext({ baseURL: baseURL(), extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    let id = 0;
    const call = async (method: string, params: unknown = {}) => {
      const r = await mcp.post('/mcp', { data: { jsonrpc: '2.0', id: ++id, method, params } });
      return { status: r.status(), body: r.status() === 200 ? await r.json() : await r.text() };
    };
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'galley-e2e', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('galley');
    const tools = await call('tools/list');
    const names: string[] = tools.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('list_resources');
    expect(names).toContain('pve_get');
    expect(names.some((n) => n.startsWith('propose_'))).toBe(false); // read scope drafts nothing
    expect(names).not.toContain('apply_change');
    const res = await call('tools/call', { name: 'pve_get', arguments: { cluster: 'demo-lab', path: '/nodes/pve1/qemu/120/config' } });
    expect(res.body.result.isError).toBeFalsy();
    expect(res.body.result.content[0].text).toContain('web01');

    // the UI shows it was used
    await page.reload();
    await settle(page);
    await expect(row.getByRole('cell').nth(3)).not.toHaveText('Never');

    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('group', { name: 'Revoke e2e-agent' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(row).toHaveCount(0);
    const after = await call('tools/list');
    expect(after.status).toBe(401);
    await mcp.dispose();

    // a browser session is not an agent token
    const csrf = (await (await page.request.get('/api/me')).json()).csrf;
    const viaCookie = await page.request.post('/mcp', { headers: { 'X-Galley-CSRF': csrf }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(viaCookie.status()).toBe(403);
  });
});
