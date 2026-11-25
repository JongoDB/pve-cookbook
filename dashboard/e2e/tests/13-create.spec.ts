import { test, expect, settle, applyChange } from '../lib/fixtures';
import { CLUSTER } from '../lib/env';

// Create: the VM and container wizards end to end.

const planReq = (page: import('@playwright/test').Page) =>
  page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/plans');

test.describe('create @fast', () => {
  test('VM wizard: every step, preview, review, apply', async ({ page }) => {
    await page.goto('/create');
    await settle(page);
    const preview = page.getByRole('complementary', { name: 'Preview' });
    await expect(page.getByLabel('VMID')).toHaveValue('301'); // /cluster/nextid
    await page.getByLabel('Name').fill('e2e-vm');
    await page.getByLabel('Tags (optional)').fill('e2e');
    await page.getByRole('button', { name: 'Next: OS and media' }).click();
    await expect(page.getByRole('heading', { name: 'OS and media' })).toBeVisible();
    await page.getByLabel('ISO image').selectOption('local:iso/debian-13.1.0-amd64-netinst.iso');
    await page.getByRole('button', { name: 'Next: System' }).click();
    await page.getByRole('button', { name: 'Next: Disk' }).click();
    await expect(page.getByLabel('Storage')).toHaveValue('vm-pool');
    await page.getByLabel('Size (GiB)').fill('40');
    await page.getByRole('button', { name: 'Next: CPU and memory' }).click();
    await page.getByLabel('Cores').fill('2');
    await page.getByLabel('Memory (MiB)').fill('4096');
    await page.getByRole('button', { name: 'Next: Network' }).click();
    await page.getByLabel('Bridge or VNet').selectOption('servers');
    await page.getByRole('button', { name: 'Next: GPU' }).click();
    await expect(page.getByRole('radio', { name: /gpu-a2-0/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible();

    await expect(preview.getByRole('list', { name: 'Before you can review' })).toHaveCount(0);
    const cli = await preview.getByLabel('Commands this change runs').innerText();
    expect(cli).toMatch(/^pvesh create \/nodes\/pve1\/qemu/);
    for (const part of ['--vmid 301', '--name e2e-vm', '--cores 2', '--memory 4096', 'vm-pool:40', 'bridge=servers', 'debian-13.1.0-amd64-netinst.iso']) expect(cli).toContain(part);
    await preview.locator('summary', { hasText: 'Request body (JSON)' }).click();
    await expect(preview.locator('.json-out')).toContainText('"path": "/nodes/pve1/qemu"');

    const req = planReq(page);
    await preview.getByRole('button', { name: 'Review change' }).click();
    const body = (await req).postDataJSON();
    expect(body).toMatchObject({ action: 'api.call', clusterId: CLUSTER, params: { title: 'Create VM 301 (e2e-vm) on pve1' } });
    expect(body.params.calls).toHaveLength(1);
    expect(body.params.calls[0]).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu', body: { vmid: '301', name: 'e2e-vm', cores: '2', memory: '4096' } });
    await applyChange(page, { title: 'Create VM 301 (e2e-vm) on pve1' });
  });

  test('VM wizard: a mapped GPU pins the VM to its nodes with HA', async ({ page }) => {
    await page.goto('/create');
    await settle(page);
    const preview = page.getByRole('complementary', { name: 'Preview' });
    await page.getByLabel('VMID').fill('305');
    await page.getByLabel('Name').fill('e2e-gpu');
    await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /GPU$/ }).click();
    await page.getByRole('radio', { name: /gpu-a2-0/ }).first().check();
    const keep = page.getByRole('checkbox', { name: 'Keep this VM on nodes that have this GPU' });
    await expect(keep).toBeChecked();
    await expect(page.getByText('Adds the VM to HA with a strict node-affinity rule for pve1')).toBeVisible();
    const cli = preview.getByLabel('Commands this change runs');
    await expect(cli).toContainText('mapping=gpu-a2-0');
    await expect(cli).toContainText('pvesh create /cluster/ha/resources --sid vm:305 --state stopped');
    await expect(cli).toContainText("pvesh create /cluster/ha/rules --comment 'galley: gpu-a2-0 only exists on these nodes' --nodes pve1 --resources vm:305 --rule gpu-305 --strict 1 --type node-affinity");
    // starting: HA starts it, so the create call carries no start=1
    await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /General$/ }).click();
    await page.getByLabel('Start after it is created').check();
    await expect(cli).toContainText('--sid vm:305 --state started');
    await expect(cli).not.toContainText('--start 1');
    await expect(preview).toContainText('3 API calls');
    // unticked: one call again
    await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /GPU$/ }).click();
    await keep.uncheck();
    await expect(preview).toContainText('1 API call');
    await expect(cli).toContainText('--start 1');
    await keep.check();

    const req = planReq(page);
    await preview.getByRole('button', { name: 'Review change' }).click();
    const calls = (await req).postDataJSON().params.calls;
    expect(calls.map((c: { method: string; path: string }) => `${c.method} ${c.path}`)).toEqual(['POST /nodes/pve1/qemu', 'POST /cluster/ha/resources', 'POST /cluster/ha/rules']);
    expect(calls[2].body).toMatchObject({ rule: 'gpu-305', type: 'node-affinity', resources: 'vm:305', nodes: 'pve1', strict: '1' });
    await applyChange(page, { title: 'Create VM 305 (e2e-gpu) on pve1' });
    const rules = await (await page.request.get(`/api/clusters/${CLUSTER}/pve/cluster/ha/rules`)).json();
    expect(rules.data).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'gpu-305', type: 'node-affinity', resources: 'vm:305', nodes: 'pve1', strict: 1 })]));
  });

  test('VM wizard: invalid input blocks the review', async ({ page }) => {
    await page.goto('/create');
    await settle(page);
    await page.getByLabel('Name').fill('not a name');
    await page.getByLabel('VMID').fill('42');
    const problems = page.getByRole('list', { name: 'Before you can review' });
    await expect(problems).toContainText('Name must be a DNS name');
    await expect(problems).toContainText('VMID must be a number from 100');
    await expect(page.getByRole('complementary', { name: 'Preview' }).getByRole('button', { name: 'Review change' })).toBeDisabled();
    // the LLM preset fills a GPU from the mapping on pve1
    await page.getByLabel('Name').fill('llm2');
    await page.getByLabel('VMID').fill('302');
    await page.getByRole('button', { name: 'Use the LLM server preset' }).click();
    await expect(page.getByRole('complementary', { name: 'Preview' }).getByLabel('Commands this change runs')).toContainText('mapping=gpu-a2-0');
  });

  test('container wizard', async ({ page }) => {
    await page.goto('/create');
    await settle(page);
    await page.getByRole('tab', { name: 'Container' }).click();
    await expect(page).toHaveURL(/kind=ct/);
    await page.getByLabel('Hostname').fill('e2e-ct');
    const problems = page.getByRole('list', { name: 'Before you can review' });
    await expect(problems).toContainText('Add at least one SSH public key');
    await page.getByLabel('SSH public keys for root').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e e2e@test');
    await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /Template$/ }).click();
    await expect(page.getByRole('combobox', { name: 'Template' })).toHaveValue('local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst');
    await expect(problems).toHaveCount(0);
    const req = planReq(page);
    await page.getByRole('complementary', { name: 'Preview' }).getByRole('button', { name: 'Review change' }).click();
    expect((await req).postDataJSON().params.calls[0]).toMatchObject({ method: 'POST', path: '/nodes/pve1/lxc', body: { hostname: 'e2e-ct' } });
    await applyChange(page, { title: /^Create container 301 \(e2e-ct\) on pve1$/ });
  });

  test('container wizard: share the NVIDIA GPU of the host', async ({ page }) => {
    await page.goto('/create?kind=ct');
    await settle(page);
    await page.getByLabel('CT ID').fill('306');
    await page.getByLabel('Hostname').fill('e2e-cuda');
    await page.getByLabel('SSH public keys for root').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e e2e@test');
    await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /GPU$/ }).click();
    await page.getByRole('radio', { name: 'Share an NVIDIA GPU (host driver)' }).check();
    await expect(page.getByLabel('NVIDIA GPU number')).toHaveValue('0');
    await expect(page.getByRole('button', { name: 'Check on pve1' })).toBeVisible(); // root is a host admin
    const preview = page.getByRole('complementary', { name: 'Preview' });
    const cli = preview.getByLabel('Commands this change runs');
    for (const d of ['--dev0 /dev/nvidia0', '--dev1 /dev/nvidiactl', '--dev2 /dev/nvidia-uvm', '--dev3 /dev/nvidia-uvm-tools']) await expect(cli).toContainText(d);
    await page.getByLabel('NVIDIA GPU number').fill('1');
    await expect(cli).toContainText('--dev0 /dev/nvidia1');
    await page.getByLabel('NVIDIA GPU number').fill('0');
    const req = planReq(page);
    await preview.getByRole('button', { name: 'Review change' }).click();
    expect((await req).postDataJSON().params.calls[0].body).toMatchObject({ hostname: 'e2e-cuda', dev0: '/dev/nvidia0', dev1: '/dev/nvidiactl', dev2: '/dev/nvidia-uvm', dev3: '/dev/nvidia-uvm-tools' });
    await applyChange(page, { title: /^Create container 306 \(e2e-cuda\) on pve1$/ });
    const cfg = await (await page.request.get(`/api/clusters/${CLUSTER}/pve/nodes/pve1/lxc/306/config`)).json();
    expect(cfg.data).toMatchObject({ dev0: '/dev/nvidia0', dev1: '/dev/nvidiactl', dev2: '/dev/nvidia-uvm', dev3: '/dev/nvidia-uvm-tools' });
  });
});
