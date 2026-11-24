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
    expect(final.status).toBe('done');
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
    expect(mine.at(-1)!.status).toBe('done');
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
      .rejects.toMatchObject({ code: 'cluster_not_authed' });
    await api.clusterLogin('edge-01', { username: 'root', realm: 'pam', password: 'x' });
    expect((await api.createPlan({ action: 'guest.reboot', clusterId: 'edge-01', params: { targets: [{ vmid: 200, node: 'edge1', type: 'lxc' }] } })).steps[0].cli).toBe('pct reboot 200');
  });
});
