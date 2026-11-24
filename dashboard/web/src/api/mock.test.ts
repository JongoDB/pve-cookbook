import { describe, expect, it } from 'vitest';
import { MockApi } from './mock';
import type { AuditEntry } from './types';

describe('MockApi (demo backend honours the api.md contract)', () => {
  it('requires login, then serves fleet and guests', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await expect(api.fleet()).rejects.toMatchObject({ status: 401 });
    const me = await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    expect(me.user).toBe('root@pam');
    const f = await api.fleet();
    expect(f.totals.nodes).toBe(4);
    expect(f.findings.some((x) => x.fix?.action === 'backup.protect')).toBe(true);
    expect((await api.guests({ q: 'gpu' })).map((g) => g.vmid).sort()).toEqual([300, 310]);
  });

  it('runs a finding fix and records audit + task', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const fix = (await api.fleet()).findings.find((x) => x.fix)!;
    const plan = await api.createPlan({ action: fix.fix!.action, clusterId: fix.clusterId, params: fix.fix!.params });
    expect(plan.steps[0].cli).toBe('pvesh set /cluster/backup/nightly-all --vmid 131');
    const run = await api.runPlan(plan.id);
    expect(run.status).toBe('running'); // async 202 shape
    const final = await api.whenSettled(run.auditId);
    expect(final.status).toBe('ok');
    expect(final.results.every((r) => r.ok && r.status === 'ok')).toBe(true);
    expect((await api.fleet()).findings.some((x) => x.id === fix.id)).toBe(false);
    expect((await api.audit())[0].cli).toEqual(plan.steps.map((s) => s.cli));
    await expect(api.runPlan(plan.id)).rejects.toMatchObject({ code: 'already_ran' });
  });

  it('gates destroy on the exact confirm text', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const plan = await api.createPlan({ action: 'guest.destroy', clusterId: 'pve-lab', params: { targets: [{ vmid: 999, node: 'pve2', type: 'lxc' }] } });
    expect(plan.confirmText).toBe('destroy 999');
    await expect(api.runPlan(plan.id, 'destroy 99')).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await api.whenSettled((await api.runPlan(plan.id, 'destroy 999')).auditId);
    expect((await api.guests()).some((g) => g.vmid === 999)).toBe(false);
  });

  it('streams per-step audit events for an async run', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const frames: AuditEntry[] = [];
    const stop = api.subscribe({ audit: (a) => frames.push(a) });
    const g = (await api.guests()).find((x) => x.status === 'running' && x.clusterId === 'pve-lab' && !x.template)!;
    const plan = await api.createPlan({ action: 'guest.destroy', clusterId: 'pve-lab', params: { targets: [{ vmid: g.vmid, node: g.node, type: g.type }] } });
    expect(plan.steps.map((s) => s.cli)[0]).toMatch(/ stop /); // running guest: stop first
    const run = await api.runPlan(plan.id, plan.confirmText);
    await api.whenSettled(run.auditId);
    stop();
    const mine = frames.filter((f) => f.id === run.auditId);
    expect(mine[0].results[0].status).toBe('running');
    expect(mine.at(-1)!.status).toBe('ok');
    expect(mine.at(-1)!.results.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('requires the setup code during first-run setup', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    (api as unknown as { needsSetup: boolean }).needsSetup = true;
    await expect(api.probe(['192.0.2.50'])).rejects.toMatchObject({ code: 'setup_token_required' });
    await expect(api.probe(['192.0.2.50'], 'wrong')).rejects.toMatchObject({ code: 'setup_token_invalid' });
    expect((await api.probe(['192.0.2.50'], api.setupToken)).endpoints).toHaveLength(1);
  });

  it('refuses plans on clusters the user is not logged in to', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    await expect(api.createPlan({ action: 'guest.start', clusterId: 'edge-01', params: { targets: [{ vmid: 200, node: 'edge1', type: 'lxc' }] } }))
      .rejects.toMatchObject({ code: 'cluster_login_required' });
    await api.clusterLogin('edge-01', { password: 'x' });
    expect((await api.createPlan({ action: 'guest.reboot', clusterId: 'edge-01', params: { targets: [{ vmid: 200, node: 'edge1', type: 'lxc' }] } })).steps[0].cli).toBe('pct reboot 200');
  });

  it('serves metrics with gaps as null, prefs with 404 until saved, realms and pass-through reads', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const m = await api.metrics({ cluster: 'pve-lab', kind: 'node', id: 'pve3', timeframe: 'day' });
    expect(m.t).toHaveLength(70);
    expect(m.series.cpu!.some((v) => v === null)).toBe(true);
    const [a, b] = await api.metricsBatch([
      { cluster: 'pve-lab', kind: 'cluster', id: '', timeframe: 'hour' },
      { cluster: 'pve-lab', kind: 'guest', id: '424242', timeframe: 'hour' },
    ]);
    expect(a.series.netIn).toHaveLength(70);
    expect(b.error).toBe('no such guest');
    await expect(api.getPref('dashboard')).rejects.toMatchObject({ status: 404 });
    await api.putPref('dashboard', { version: 1 });
    expect(await api.getPref('dashboard')).toEqual({ version: 1 });
    expect((await api.realms('pve-lab')).some((r) => r.type === 'openid')).toBe(true);
    const cfg = await api.pve<Record<string, string>>('pve-lab', 'nodes/pve1/qemu/300/config');
    expect(cfg.hostpci0).toBe('mapping=gpu-a2-0,pcie=1');
    await expect(api.pve('edge-01', 'nodes/edge1/status')).rejects.toMatchObject({ status: 409, code: 'cluster_login_required' });
  });
});

describe('MockApi: assistant, api.call, hosts', () => {
  const login = async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    return api;
  };

  it('streams a GPU answer with tool lines and a draft change that runs by its own id', async () => {
    const api = await login();
    const events: string[] = [];
    let draft: import('./types').Plan | null = null;
    await api.chat({ message: 'Attach the second GPU to llm-vllm' }, (e) => {
      events.push(e.type);
      if (e.type === 'change') draft = e.plan;
    });
    expect(events[0]).toBe('tool');
    expect(events).toContain('text');
    expect(events.at(-1)).toBe('done');
    expect(draft!.source).toBe('assistant');
    expect(draft!.title).toMatch(/^Assistant draft: /);
    expect(draft!.confirmText).toBe('apply 2 steps');
    await expect(api.runPlan(draft!.id)).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await api.whenSettled((await api.runPlan(draft!.id, 'apply 2 steps')).auditId);
    const cfg = await api.pve<Record<string, string>>('pve-lab', 'nodes/pve1/qemu/300/config');
    expect(cfg.hostpci1).toBe('mapping=gpu-a2-1,pcie=1');
    expect((await api.pve<{ id: string }[]>('pve-lab', 'cluster/mapping/pci')).map((m) => m.id)).toEqual(['gpu-a2-0', 'gpu-a2-1']);
  });

  it('refuses chat when the assistant is off, and keeps the API key write-only', async () => {
    const api = await login();
    const s = await api.assistantSettings();
    expect(s.hasApiKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain('demo-key');
    await api.putAssistantSettings({ ...s.config, enabled: false });
    expect((await api.assistantStatus()).enabled).toBe(false);
    await expect(api.chat({ message: 'hi' }, () => undefined)).rejects.toMatchObject({ code: 'assistant_disabled' });
    // switching to another destination drops the stored key
    await api.putAssistantSettings({ ...s.config, enabled: true, provider: 'openai', baseUrl: 'http://gpu-host:8000/v1', model: 'qwen' });
    expect((await api.assistantSettings()).hasApiKey).toBe(false);
  });

  it('validates api.call against the schema and applies config edits', async () => {
    const api = await login();
    await expect(api.createPlan({ action: 'api.call', clusterId: 'pve-lab', params: { calls: [{ method: 'PUT', path: '/nodes/pve1/qemu/120/config', body: { bogus: '1' } }] } }))
      .rejects.toMatchObject({ message: expect.stringContaining('bogus: not a parameter') });
    const p = await api.createPlan({ action: 'api.call', clusterId: 'pve-lab', params: { calls: [{ method: 'PUT', path: '/nodes/pve1/qemu/120/config', body: { cores: '6', net2: 'virtio,bridge=vmbr1', delete: 'tags', digest: 'beef' } }] } });
    expect(p.steps[0].cli).toBe('pvesh set /nodes/pve1/qemu/120/config --cores 6 --delete tags --digest beef --net2 virtio,bridge=vmbr1');
    expect(p.confirmText).toBe('confirm 120/config'); // deleting options needs typed confirmation
    await api.whenSettled((await api.runPlan(p.id, 'confirm 120/config')).auditId);
    const cfg = await api.pve<Record<string, string | number>>('pve-lab', 'nodes/pve1/qemu/120/config');
    expect(cfg).toMatchObject({ cores: '6', net2: 'virtio,bridge=vmbr1' });
    expect(cfg.tags).toBeUndefined();
  });

  it('serves schema lookups for concrete paths', async () => {
    const api = await login();
    const s = await api.schema('pve-lab', '/nodes/pve1/qemu/300/config');
    expect(s.path).toBe('/nodes/{node}/qemu/{vmid}/config');
    expect(s.vars).toEqual({ node: 'pve1', vmid: '300' });
    expect(Object.keys(s.info).sort()).toEqual(['GET', 'POST', 'PUT']);
    expect((await api.schemaPaths('pve-lab')).some((p) => p.path === '/cluster/mapping/pci')).toBe(true);
  });

  it('pins a host only with the fingerprint the node presents, then allows host.exec', async () => {
    const api = await login();
    const scan = await api.scanHost('pve-lab', 'pve2');
    await expect(api.pinHost('pve-lab', 'pve2', `SHA256:${'A'.repeat(43)}`)).rejects.toMatchObject({ code: 'fingerprint_mismatch' });
    await expect(api.createPlan({ action: 'host.exec', clusterId: 'pve-lab', params: { node: 'pve2', command: 'uptime' } })).rejects.toMatchObject({ status: 400 });
    await api.pinHost('pve-lab', 'pve2', scan.fingerprint);
    const h = await api.hosts('pve-lab');
    expect(h.transport).toBe('ssh');
    expect(h.nodes.find((n) => n.node === 'pve2')?.pin?.fingerprint).toBe(scan.fingerprint);
    const p = await api.createPlan({ action: 'host.exec', clusterId: 'pve-lab', params: { node: 'pve2', command: 'ethtool -a enp65s0f0' } });
    expect(p.confirmText).toBe('run on pve2');
    const done = await api.whenSettled((await api.runPlan(p.id, 'run on pve2')).auditId);
    expect(done.results[0].output).toContain('Pause parameters');
  });
});

describe('MockApi: host transports and credential modes', () => {
  it('pve transport needs no pin or key, and runs only for root@pam', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'admin', realm: 'pve', password: 'x' });
    await api.updateCluster('pve-lab', { hostTransport: 'pve' });
    const h = await api.hosts('pve-lab');
    expect(h).toMatchObject({ transport: 'pve' });
    expect(h.authorizedKey).toBeUndefined();
    expect(h.nodes.every((n) => !n.pin)).toBe(true); // switching to pve deleted the key and pins
    await expect(api.scanHost('pve-lab', 'pve1')).rejects.toMatchObject({ status: 400 });
    const p = await api.createPlan({ action: 'host.exec', clusterId: 'pve-lab', params: { node: 'pve1', command: 'uptime' } });
    const done = await api.whenSettled((await api.runPlan(p.id, 'run on pve1')).auditId);
    expect(done.results[0].error).toMatch(/only to root@pam/);
  });

  it('reports credential modes and maxExpires, and token creation failures', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    const me = await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    expect(me.maxExpires! - me.expires!).toBe(8 * 3600);
    expect(me.clusters.find((c) => c.id === 'edge-01')).toMatchObject({ credentialMode: 'token', authed: false });
    await expect(api.clusterLogin('edge-01', { password: 'tokenfail' })).rejects.toMatchObject({ status: 502, code: 'credential_failed' });
    expect((await api.clusters()).find((c) => c.id === 'pve-lab')).toMatchObject({ credentialMode: 'ticket', hostTransport: 'ssh' });
  });

  it('serves the user guide from docs/user with front matter parsed', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const idx = await api.docs();
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.map((d) => d.order)).toEqual([...idx.map((d) => d.order)].sort((a, b) => a - b));
    expect(idx.find((d) => d.slug === 'getting-started')).toMatchObject({ title: 'Getting started' });
    const doc = await api.doc('getting-started');
    expect(doc.markdown.startsWith('---')).toBe(false);
    expect(doc).not.toHaveProperty('markdown', '');
    await expect(api.doc('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('runs galley.* actions as GALLEY steps through Changes', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    const plan = await api.createPlan({ action: 'galley.cluster.update', clusterId: 'pve-lab', params: { shareLogin: true } });
    expect(plan.steps).toEqual([expect.objectContaining({ method: 'GALLEY', path: 'galley.cluster.update', body: { shareLogin: 'true' } })]);
    expect(plan.steps[0].cli).not.toMatch(/pvesh/);
    expect((await api.plans()).some((p) => p.id === plan.id)).toBe(true);
    const final = await api.whenSettled((await api.runPlan(plan.id)).auditId);
    expect(final.status).toBe('ok');
    expect((await api.clusters()).find((c) => c.id === 'pve-lab')?.shareLogin).toBe(true);
    expect((await api.plans()).some((p) => p.id === plan.id)).toBe(false);
    const rm = await api.createPlan({ action: 'galley.cluster.remove', clusterId: 'pve-lab', params: {} });
    expect(rm).toMatchObject({ destructive: true, confirmText: 'remove pve-lab' });
    await expect(api.createPlan({ action: 'galley.cluster.update', clusterId: 'pve-lab', params: { evil: 1 } })).rejects.toMatchObject({ status: 400 });
  });

  it('creates, lists and revokes agent tokens', async () => {
    const api = new MockApi({ stepDelayMs: 0 });
    await api.login({ clusterId: 'pve-lab', username: 'root', realm: 'pam', password: 'x' });
    await expect(api.createAgentToken({ name: 'bad name', scope: 'read', days: 7 })).rejects.toMatchObject({ status: 400 });
    await expect(api.createAgentToken({ name: 'ok', scope: 'read', days: 91 })).rejects.toMatchObject({ status: 400 });
    const t = await api.createAgentToken({ name: 'ci', scope: 'draft', days: 7 });
    expect(t.token).toMatch(/^glly_/);
    expect((await api.agentTokens()).map((x) => x.name)).toContain('ci');
    expect(await api.agentTokens()).not.toContainEqual(expect.objectContaining({ token: expect.anything() }));
    await api.deleteAgentToken(t.id);
    expect((await api.agentTokens()).map((x) => x.name)).not.toContain('ci');
  });
});
