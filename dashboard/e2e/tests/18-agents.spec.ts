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
    await expect(create.getByRole('note')).toContainText('An apply token applies routine guest work');
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

  test('host commands by an apply agent wait for a person; an admin can always allow', async ({ page }) => {
    await page.goto('/agents');
    await settle(page);
    const create = page.getByRole('region', { name: 'Create a token' });
    await create.getByLabel('Name').fill('e2e-apply');
    await create.getByRole('radio', { name: /^apply:/ }).check();
    await expect(create.getByRole('note')).toContainText('You still apply the rest yourself');
    await create.getByRole('button', { name: 'Create token' }).click();
    const fresh = page.getByRole('region', { name: 'Token for e2e-apply' });
    const token = (await fresh.getByLabel('Agent token').innerText()).trim();
    await fresh.getByRole('button', { name: 'Done, I copied it' }).click();
    const mcp = await request.newContext({ baseURL: baseURL(), extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    let id = 0;
    const tool = async (name: string, args: unknown) => {
      const r = await mcp.post('/mcp', { data: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } });
      const res = (await r.json()).result;
      return { isError: !!res.isError, text: res.content[0].text as string };
    };
    const draft = async (command: string) => JSON.parse((await tool('propose_host_command', { cluster: 'demo-lab', node: 'pve1', command, reason: 'e2e' })).text);
    const d = await draft('uptime');
    expect(d.needsPerson).toBe(true);
    const refused = await tool('apply_change', { changeId: d.changeId, confirm: d.confirmText });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('a person must apply this change');

    // the draft is waiting for the person, who can open it
    await page.reload();
    await settle(page);
    const plans = await (await page.request.get('/api/plans')).json();
    const waiting = plans.find((p: { id: string }) => p.id === d.changeId);
    expect(waiting.expiresAt - waiting.createdAt).toBe(86400);

    // loosening needs an explicit tick; tightening does not
    await page.goto('/settings');
    await settle(page);
    const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Agent approval' }) });
    const save = form.getByRole('button', { name: 'Save agent approval' });
    await expect(form.getByRole('radio', { name: /^Everything but routine guest work:/ })).toBeChecked();
    await expect(save).toBeDisabled();
    await form.getByRole('radio', { name: /^Nothing, always allow:/ }).check();
    await expect(save).toBeDisabled();
    await form.getByRole('checkbox', { name: 'I understand, let agents apply everything' }).check();
    await save.click();
    await expect(form.getByRole('status')).toContainText('Saved.');
    await expect(form.locator('.panel-head')).toContainText('always allow');
    const d2 = await draft('hostname');
    expect(d2.needsPerson).toBeUndefined();
    expect((await tool('apply_change', { changeId: d2.changeId, confirm: d2.confirmText })).isError).toBe(false);

    // back to the default, which applies at once
    await form.getByRole('radio', { name: /^Everything but routine guest work:/ }).check();
    await save.click();
    await expect(form.locator('.panel-head')).toContainText('For everything but routine guest work');
    expect((await tool('apply_change', { changeId: d.changeId, confirm: d.confirmText })).isError).toBe(true);
    const csrf = (await (await page.request.get('/api/me')).json()).csrf;
    for (const t of await (await page.request.get('/api/agent-tokens')).json()) {
      if (t.name === 'e2e-apply') await page.request.delete(`/api/agent-tokens/${t.id}`, { headers: { 'X-Galley-CSRF': csrf } });
    }
    await page.request.delete(`/api/plans/${d.changeId}`, { headers: { 'X-Galley-CSRF': csrf } });
    await mcp.dispose();
  });
});
