import { test, expect, settle } from '../lib/fixtures';
import { FakeLlm } from '../lib/fakeLlm';
import { Session } from '../lib/api';
import { CLUSTER } from '../lib/env';

// The in-app assistant end to end, against a scripted OpenAI-compatible model
// (lib/fakeLlm.ts) that galley is configured to use like any other provider.
// galley runs the tools for real against the fake cluster.

const llm = new FakeLlm();
let admin: Session;

test.beforeAll(async () => {
  const url = await llm.start();
  admin = await Session.login('root');
  const r = await admin.send('PUT', '/api/settings/assistant', { enabled: true, provider: 'openai', baseUrl: url, model: 'e2e-scripted', apiKey: 'sk-e2e' });
  expect(r.status()).toBe(204);
});

test.afterAll(async () => {
  await admin.send('PUT', '/api/settings/assistant', { enabled: false, provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'e2e-scripted', clearApiKey: true });
  await admin.dispose();
  await llm.stop();
});

test.describe('assistant @fast', () => {
  test('a question runs tools, answers with links and suggestions, and drafts a change', async ({ page }) => {
    llm.reset([
      { text: 'Let me look at web01. ', tool: 'pve_get', args: { cluster: CLUSTER, path: '/nodes/pve1/qemu/120/config' } },
      { tool: 'propose_change', args: { cluster: CLUSTER, title: 'Give web01 two more cores', calls: [{ method: 'PUT', path: '/nodes/pve1/qemu/120/config', body: { cores: '6' } }] } },
      { text: '[web01](/guests/demo-lab/120) has 4 cores. I drafted a change that gives it 6; review it in Changes.\n\n<suggestions>\n- Show its snapshots\n- Which node has the most free memory?\n</suggestions>' },
      { text: 'It has one snapshot, pre-upgrade.' },
    ]);
    await page.goto(`/guests/${CLUSTER}/120`);
    await settle(page);
    await page.getByRole('button', { name: 'Open Assistant' }).click();
    const drawer = page.getByRole('complementary', { name: 'Drawer' });
    await expect(drawer).toContainText('e2e-scripted');
    await expect(drawer).toContainText('are sent to 127.0.0.1');
    // starter questions name the guest of this page
    await expect(drawer.locator('.chat-examples button').first()).toBeVisible();

    await drawer.getByRole('textbox', { name: 'Message the assistant' }).fill('Can web01 get more CPU?');
    await page.keyboard.press('Enter');
    const answer = drawer.locator('.msg-assistant').last();
    await expect(drawer.locator('.msg-user')).toContainText('Can web01 get more CPU?');
    await expect(answer.locator('.tool-line')).toHaveCount(2, { timeout: 15_000 });
    await expect(answer.locator('.tool-line.tool-ok')).toHaveCount(2);
    await expect(answer).toContainText('Let me look at web01.');
    await expect(answer).toContainText('has 4 cores');
    await expect(answer).not.toContainText('<suggestions>');

    // what galley sent the model: the question, then the real tool result from the cluster
    expect(llm.requests[0].messages.at(-1)).toMatchObject({ role: 'user', content: 'Can web01 get more CPU?' });
    expect(JSON.stringify(llm.requests[1].messages.at(-1))).toContain('web01');
    expect(llm.requests[0].tools.map((t) => (t as { function: { name: string } }).function.name)).not.toContain('apply_change');

    // the drafted change, labelled, waiting in Changes
    const card = answer.locator('.chat-change');
    await expect(card).toContainText('Assistant draft');
    await expect(card).toContainText('Give web01 two more cores');
    await expect(card.getByLabel('Commands this draft would run')).toContainText('--cores 6');
    // Changes counts it as waiting at once
    await expect(drawer.getByRole('tab', { name: /^Changes/ })).toContainText('1');

    // suggestions become buttons; a link navigates inside galley
    const chips = answer.getByRole('group', { name: 'Suggested replies' }).getByRole('button');
    await expect(chips).toHaveText(['Show its snapshots', 'Which node has the most free memory?']);
    // move away inside the app (the conversation lives in the page), then follow the link
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Overview' }).click();
    await settle(page);
    const link = drawer.locator('.msg-assistant').last().getByRole('link', { name: 'web01' });
    let reloaded = false;
    page.once('load', () => { reloaded = true; });
    await link.click();
    await expect(page).toHaveURL(`/guests/${CLUSTER}/120`);
    expect(reloaded, 'links in answers navigate inside the app').toBe(false);

    await drawer.locator('.msg-assistant').last().getByRole('group', { name: 'Suggested replies' }).getByRole('button', { name: 'Show its snapshots' }).click();
    await expect(drawer.locator('.msg-user').last()).toHaveText('You: Show its snapshots');
    await expect(drawer.locator('.msg-assistant').last()).toContainText('pre-upgrade');
    // a follow-up continues the same conversation
    expect(llm.requests.at(-1)!.messages.some((m) => m.content === 'Can web01 get more CPU?')).toBe(true);

    // review the draft in Changes: typed confirmation, apply
    await drawer.locator('.chat-change').getByRole('button', { name: /in Changes$/ }).click();
    const panel = drawer.getByRole('tabpanel');
    await expect(panel.locator('.change-title')).toHaveText('Assistant draft: Give web01 two more cores');
    await expect(panel.locator('.badge').first()).toHaveText(/Assistant/);
    await panel.getByLabel(/^Type .* to confirm$/).fill('apply 1 step');
    await panel.getByRole('button', { name: 'Apply change' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Change applied' })).toBeVisible();

    // New conversation clears the log
    await drawer.getByRole('tab', { name: 'Assistant' }).click();
    await drawer.getByRole('button', { name: 'New conversation' }).click();
    await expect(drawer.locator('.msg-user')).toHaveCount(0);
  });

  test('the palette sends a question to the assistant', async ({ page }) => {
    llm.reset([{ text: 'Three nodes, all online.' }]);
    await page.goto('/');
    await settle(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Ask, search or run a command' }).fill('how many nodes are online?');
    await expect(page.getByRole('option').first()).toContainText('Ask the assistant: how many nodes are online?');
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('complementary', { name: 'Drawer' });
    await expect(drawer.locator('.msg-assistant').last()).toContainText('Three nodes, all online.');
  });

  test('a model error is shown in the conversation', async ({ page }) => {
    llm.reset([{ tool: 'no_such_tool', args: {} }, { text: 'Sorry, that tool does not exist.' }]);
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Open Assistant' }).or(page.getByRole('tab', { name: 'Assistant' })).first().click();
    const drawer = page.getByRole('complementary', { name: 'Drawer' });
    await drawer.getByRole('textbox', { name: 'Message the assistant' }).fill('do something odd');
    await drawer.getByRole('button', { name: 'Send' }).click();
    const answer = drawer.locator('.msg-assistant').last();
    await expect(answer.locator('.tool-line.tool-error')).toHaveCount(1);
    await expect(answer).toContainText('Sorry, that tool does not exist.');
  });
});
