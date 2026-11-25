// End-to-end tests for galley: the real binary in demo mode (in-process fake
// PVE cluster), driven by Chromium. See ../README.md ("end-to-end tests").
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The config is evaluated by the runner and again by every worker: pick the
// port and the data directory once and hand them down through the environment.
if (!process.env.GALLEY_E2E_PORT) {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  process.env.GALLEY_E2E_PORT = execFileSync(process.execPath, ['-e', script]).toString().trim();
}
if (!process.env.GALLEY_E2E_TMP) process.env.GALLEY_E2E_TMP = mkdtempSync(join(tmpdir(), 'galley-e2e-'));

const port = process.env.GALLEY_E2E_PORT;
const bin = resolve(process.env.GALLEY_BIN ?? '../galley');
export const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  // One galley, one fake cluster: tests share state (guest power states,
  // settings, the audit log), so they run one at a time in a fixed order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  globalSetup: './global-setup.ts',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: 'only-on-failure',
    // galley is served over plain HTTP here; the clipboard needs a permission grant.
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // --demo keeps its database under $TMPDIR (a fresh directory per run);
    // --data is passed for completeness. --poll 1s makes fleet changes show quickly.
    command: `"${bin}" --demo --insecure-http --listen 127.0.0.1:${port} --poll 1s --data "${join(process.env.GALLEY_E2E_TMP, 'data')}"`,
    url: `${baseURL}/api/health`,
    env: { TMPDIR: process.env.GALLEY_E2E_TMP },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
