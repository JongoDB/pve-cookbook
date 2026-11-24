import type { Page, WebSocket } from '@playwright/test';
import { test, expect, settle } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Consoles: galley asks PVE for a ticket, then proxies the websocket. The
// fake cluster answers with a node shell (termproxy), a container login and
// a minimal VNC server.

function consoleSocket(page: Page): Promise<WebSocket> {
  return page.waitForEvent('websocket', (ws) => new URL(ws.url()).pathname.startsWith('/api/console/'));
}

test.describe('consoles @fast', () => {
  test('node shell: terminal connects and runs input', async ({ page }) => {
    const ws = consoleSocket(page);
    await page.goto(`/console/${CLUSTER}/node/pve1`);
    const sock = await ws;
    const frames: string[] = [];
    sock.on('framereceived', (f) => frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString()));
    await expect(page.getByRole('button', { name: 'Full screen' })).toBeEnabled({ timeout: 10_000 }); // connected
    const term = page.locator('.console-screen .xterm-rows');
    await expect(term).toContainText('root@pve1');
    await page.locator('.console-screen').click();
    await page.keyboard.type('uptime');
    await page.keyboard.press('Enter');
    await expect(term).toContainText('uptime: command not found');
    expect(frames.join('')).toContain('command not found');
    // back link
    await page.getByRole('link', { name: 'Back to pve1' }).click();
    await expect(page).toHaveURL(`/nodes/${CLUSTER}/pve1`);
    await expect.poll(() => sock.isClosed(), { message: 'leaving the page closes the console socket' }).toBe(true);
  });

  test('VM console: noVNC connects over the proxied websocket', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/120`);
    await settle(page);
    const ws = consoleSocket(page);
    await page.getByRole('link', { name: 'Console' }).click();
    await expect(page).toHaveURL(`/console/${CLUSTER}/qemu/pve1/120`);
    const sock = await ws;
    expect(sock.url()).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/console\/[0-9a-f]{48}$/);
    await expect(page.getByRole('button', { name: 'Send Ctrl+Alt+Del' })).toBeEnabled({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Send Ctrl+Alt+Del' }).click();
    // Reconnect asks for a new one-time ticket and connects again
    const again = consoleSocket(page);
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await again;
    await expect(page.getByRole('button', { name: 'Send Ctrl+Alt+Del' })).toBeEnabled({ timeout: 10_000 });
  });

  test('container console shows its login prompt', async ({ page }) => {
    await page.goto(`/console/${CLUSTER}/lxc/pve2/131`);
    await expect(page.getByRole('button', { name: 'Full screen' })).toBeEnabled({ timeout: 10_000 });
    await expect(page.locator('.console-screen .xterm-rows')).toContainText('grafana login:');
  });

  test('a stopped guest has no console link', async ({ page }) => {
    await page.goto(`/guests/${CLUSTER}/300`);
    await settle(page);
    const link = page.getByRole('link', { name: 'Console' });
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    await link.click({ force: true }); // a disabled-looking link must not navigate either
    await expect(page).toHaveURL(`/guests/${CLUSTER}/300`);
  });
});
